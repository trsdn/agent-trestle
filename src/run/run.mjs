import { createAuditRecorder, generateRunId } from "../audit/recorder.mjs";
import { dispatch as defaultDispatch } from "../dispatch/dispatch.mjs";
import { resolveRoute, resolveWorkstreamDirectory } from "../dispatch/router.mjs";
import { ManifestError, resolveTaskPrompts } from "../manifest/manifest.mjs";
import { runRounds, runTaskGraph } from "../scheduler/index.mjs";
import { createGitWorkSignatureProvider } from "./git-work-signature.mjs";
import { createTaskWorktrees } from "./task-worktrees.mjs";

export const RUN_STATUS = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
  BLOCKED: "blocked",
});

/** A task that ran once because it declared no stop conditions. */
const SINGLE_DISPATCH = "single-dispatch";

export class TaskExecutionError extends Error {
  constructor(taskId, execution) {
    super(`task ${taskId} failed: copilot ${execution.status}`);
    this.name = "TaskExecutionError";
    this.code = "TASK_FAILED";
    this.taskId = taskId;
    this.execution = execution;
  }
}

/**
 * Raw stdout and stderr are deliberately omitted. Each stream is capped at
 * 10 MiB per dispatch, so a graph of many multi-round tasks would otherwise
 * produce a `--json` payload hundreds of megabytes wide. Byte counts preserve
 * the signal that output was produced without carrying it.
 */
function summarizeExecution(execution) {
  const {
    stdout = "",
    stderr = "",
    error,
    ...rest
  } = execution;
  return {
    ...rest,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
    ...(error ? { error: { message: error.message, code: error.code } } : {}),
  };
}

function summarizeDispatch(result) {
  return {
    route: result.route,
    agent: result.agent,
    skills: result.skills,
    permissions: result.permissions,
    execution: summarizeExecution(result.execution),
  };
}

function stopBounds(stop) {
  return {
    maxRounds: stop.maxRounds ?? Infinity,
    maxDurationMs: stop.maxDurationMs ?? Infinity,
    maxNoOpRounds: stop.maxNoOpRounds ?? 1,
  };
}

// Route resolution wrapped so an unknown project/workstream/role in a manifest
// is reported as a manifest problem, before anything is spawned.
function resolveManifestRoute(config, task) {
  try {
    return resolveRoute(config, {
      projectId: task.route.project,
      workstreamId: task.route.workstream,
      roleId: task.route.role,
    });
  } catch (error) {
    throw new ManifestError(`manifest task ${task.id}: ${error.message}`, "UNKNOWN_ROUTE");
  }
}

/**
 * Executes one manifest task graph. Tasks run in dependency order under a
 * bounded concurrency limit; a task that declares stop conditions runs repeated
 * rounds until it converges or hits a declared bound.
 */
export async function runManifest({
  config,
  projectRoot,
  manifest,
  concurrency = 1,
  binary,
  signal,
  dispatchImpl = defaultDispatch,
  workSignatureProvider,
  createSignatureProvider = createGitWorkSignatureProvider,
  createRecorder = createAuditRecorder,
  auditEnabled = true,
  isolate = false,
  worktreeRoot,
  createWorktrees = createTaskWorktrees,
  resolveWorkstreamDirectoryImpl = resolveWorkstreamDirectory,
  resolvePrompts = resolveTaskPrompts,
  clock,
  failureSettlementMs,
} = {}) {
  if (!config) throw new TypeError("config is required");
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    throw new TypeError("projectRoot must be an explicit path");
  }
  if (!manifest || !Array.isArray(manifest.tasks)) {
    throw new TypeError("manifest must be a validated task manifest");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }

  // Routes are resolved before anything is spawned so an unknown project,
  // workstream or role fails the whole run rather than half of it.
  for (const task of manifest.tasks) resolveManifestRoute(config, task);

  const resolved = await resolvePrompts(projectRoot, manifest);
  const observations = new Map();
  // Run-scoped audit root: every task gets its own writer, so parallel tasks
  // exercise the independent-segment design instead of sharing a hash chain.
  const runId = manifest.id ?? generateRunId("run");
  // Worktree and branch names must be unique per invocation. `git worktree add
  // -b` refuses a branch that already exists and `remove` deliberately leaves
  // branches behind, so deriving names from a declared `manifest.id` makes the
  // second isolated run of a named manifest fail on every task.
  const isolationRunId = manifest.id ? generateRunId("run") : runId;
  const runAudit = createRecorder({
    projectRoot,
    runId,
    taskId: "run",
    writerId: "run",
    enabled: auditEnabled,
  });
  const taskAudit = (taskId) => createRecorder({
    projectRoot,
    runId,
    taskId,
    writerId: "dispatch",
    enabled: auditEnabled,
  });

  const worktrees = isolate
    ? createWorktrees({
      projectRoot,
      ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
    })
    : null;

  const dispatchOnce = async (task, taskSignal, audit, workingDirectory) => {
    const result = await dispatchImpl({
      config,
      projectRoot,
      projectId: task.route.project,
      workstreamId: task.route.workstream,
      roleId: task.route.role,
      prompt: task.prompt,
      requestedSkills: task.skills ?? [],
      ...(binary === undefined ? {} : { binary }),
      ...(taskSignal === undefined ? {} : { signal: taskSignal }),
      ...(audit === undefined ? {} : { audit }),
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
    });
    // A non-zero exit, a timeout or an output-cap kill must surface as a task
    // failure. Success-shaped reporting of a failed process is the one thing
    // this project refuses to do.
    if (!result.execution.ok) throw new TaskExecutionError(task.id, result.execution);
    return result;
  };

  const runTask = async (task, taskSignal) => {
    const dispatches = [];
    const audit = taskAudit(task.id);
    // Each task owns its checkout, so two tasks routed to the same workstream
    // never share a working tree.
    const taskKey = `${isolationRunId}--${task.id}`;
    const worktree = worktrees ? await worktrees.acquire(taskKey) : null;
    const workingDirectory = worktree?.path;
    if (worktree) {
      await audit.record("worktree.created", { taskId: task.id, worktree });
    }

    const isolation = () => (worktree
      ? { worktree: { id: worktree.id, branch: worktree.branch, path: worktree.path } }
      : {});

    try {
      if (!task.stop) {
        dispatches.push(summarizeDispatch(
          await dispatchOnce(task, taskSignal, audit, workingDirectory),
        ));
        const released = worktrees ? await worktrees.release(taskKey) : null;
        if (released) await audit.record("worktree.released", { taskId: task.id, worktree: released });
        return {
          rounds: 1,
          stop: { reason: SINGLE_DISPATCH },
          dispatches,
          ...isolation(),
          ...(released ? { worktreeStatus: released.status } : {}),
        };
      }

      let provider = workSignatureProvider;
      if (!provider) {
        const repoRoot = workingDirectory
          ?? await resolveWorkstreamDirectoryImpl(projectRoot, resolveManifestRoute(config, task));
        provider = createSignatureProvider({ repoRoot });
      }

      const outcome = await runRounds({
        runRound: async () => {
          dispatches.push(summarizeDispatch(
            await dispatchOnce(task, taskSignal, audit, workingDirectory),
          ));
          return { completed: false };
        },
        workSignatureProvider: provider,
        ...stopBounds(task.stop),
        signal: taskSignal,
        ...(clock === undefined ? {} : { clock }),
      });

      const released = worktrees ? await worktrees.release(taskKey) : null;
      if (released) await audit.record("worktree.released", { taskId: task.id, worktree: released });
      return {
        rounds: outcome.rounds.length,
        stop: {
          reason: outcome.reason,
          ...(outcome.noOpRounds === undefined ? {} : { noOpRounds: outcome.noOpRounds }),
        },
        dispatches,
        ...isolation(),
        ...(released ? { worktreeStatus: released.status } : {}),
      };
    } catch (error) {
      // Only genuine agent failure retains a checkout for inspection. An abort
      // also surfaces as a non-ok execution, so the two are told apart by the
      // `aborted` flag rather than by error type: an interruption is the
      // operator stopping the run, not a reviewable result, and must not
      // accumulate a checkout on every Ctrl-C.
      if (worktrees) {
        // Classify on the execution's own flag. The scheduler shares one
        // AbortSignal across the whole graph and aborts it as soon as any task
        // fails, so testing the signal first made a genuinely failed sibling
        // look interrupted and destroyed the checkout that failure retention
        // exists to preserve. The signal is only consulted when there is no
        // execution to speak for itself (e.g. throwIfAborted before dispatch).
        const interrupted = error?.execution
          ? error.execution.aborted === true
          : taskSignal?.aborted === true;
        const failed = !interrupted && error instanceof TaskExecutionError;
        const released = await worktrees.release(taskKey, { failed }).catch(() => null);
        if (released) {
          await audit
            .record(failed ? "worktree.retained" : "worktree.released", {
              taskId: task.id,
              worktree: released,
            })
            .catch(() => null);
          error.worktree = released;
        }
      }
      throw error;
    }
  };

  await runAudit.record("run.started", {
    runId,
    concurrency,
    tasks: resolved.tasks.map((task) => ({
      id: task.id,
      route: task.route,
      dependsOn: task.dependsOn,
      ...(task.stop ? { stop: task.stop } : {}),
    })),
  });

  let graph;
  let teardown = null;
  try {
    graph = await runTaskGraph({
      tasks: resolved.tasks.map((task) => ({
        id: task.id,
        dependsOn: task.dependsOn,
        run: async ({ signal: taskSignal }) => {
          const observation = await runTask(task, taskSignal);
          observations.set(task.id, observation);
          return observation;
        },
      })),
      concurrency,
      ...(signal === undefined ? {} : { signal }),
      ...(failureSettlementMs === undefined ? {} : { failureSettlementMs }),
    });
  } finally {
    // Anything still held belongs to work that never reached its own release —
    // an interrupted run. Releasing here, and pruning Git's registry, is what
    // stops an abort from stranding worktrees.
    if (worktrees) teardown = await worktrees.releaseAll();
  }

  const result = buildRunResult({ manifest: resolved, graph, concurrency, observations, runId });
  await runAudit.record("run.settled", {
    runId,
    status: result.status,
    ...(result.failedTask === undefined ? {} : { failedTask: result.failedTask }),
    ...(result.blocked === undefined ? {} : { blocked: result.blocked }),
    ...(teardown === null ? {} : { teardown }),
    tasks: result.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      ...(task.rounds === undefined ? {} : { rounds: task.rounds }),
      ...(task.stop === undefined ? {} : { stop: task.stop }),
    })),
  });
  return {
    ...result,
    ...(worktrees === null ? {} : { isolation: { enabled: true, worktreeRoot: worktrees.worktreeRoot } }),
    audit: runAudit.enabled ? { enabled: true, runId, auditRoot: runAudit.auditRoot } : { enabled: false },
  };
}

function buildRunResult({ manifest, graph, concurrency, observations, runId }) {
  const tasks = manifest.tasks.map((task) => {
    const state = graph.states.get(task.id);
    const observation = observations.get(task.id);
    const failure = state === "failed" ? graph.results.get(task.id) : undefined;
    return {
      id: task.id,
      status: state,
      route: task.route,
      dependsOn: task.dependsOn,
      ...(observation ?? {}),
      // A failed task's checkout is deliberately kept, but the catch block only
      // recorded it on the error. Without surfacing it here the operator is told
      // a task failed and never told a worktree was retained or where it is.
      ...(failure?.worktree
        ? {
          worktree: {
            id: failure.worktree.id,
            branch: failure.worktree.branch,
            path: failure.worktree.path,
          },
          worktreeStatus: failure.worktree.status,
        }
        : {}),
      ...(failure
        ? {
          error: {
            message: failure.message,
            code: failure.code ?? "FAILED",
            ...(failure.execution ? { execution: summarizeExecution(failure.execution) } : {}),
          },
        }
        : {}),
    };
  });

  return {
    ok: graph.status === RUN_STATUS.COMPLETED,
    status: graph.status,
    runId,
    concurrency,
    tasks,
    ...(graph.status === RUN_STATUS.BLOCKED ? { blocked: graph.blocked } : {}),
    ...(graph.status === RUN_STATUS.FAILED ? { failedTask: graph.failedTask } : {}),
  };
}
