import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { auditRootFor, reconcileAuditTask } from "../audit/index.mjs";
import { DEFAULT_LIMITS, normalizeDashboardModel } from "./model.mjs";

/**
 * Runtime records are reconstructed from the audit segments the runtime already
 * writes, rather than from a separate store. Audit reconciliation is
 * deterministic and integrity-checked, which is exactly what a read-only view
 * needs, and it means the dashboard cannot drift from what actually happened.
 *
 * The dashboard remains a consumer with no authority: nothing here writes.
 */
export const RUN_TASK_ID = "run";
export const REVIEW_TASK_ID = "review";
export const FLEET_TASK_ID = "fleet";

const DEFAULT_MAX_RUNS = 50;

async function listDirectories(target) {
  try {
    const entries = await readdir(target, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  }
}

/**
 * Orders run directories oldest first by modification time.
 *
 * Their names cannot be sorted by time: run ids come from four different
 * generators (`dispatch-`, `fleet-`, `review-`, `run-`) plus arbitrary manifest
 * ids, and time ordering only holds within one prefix. A lexicographic sort
 * therefore starves every `dispatch-*` run as soon as fifty `run-*` directories
 * exist, dropping a dispatch from a minute ago while keeping a run from last
 * year.
 */
async function listRunsOldestFirst(runsRoot) {
  const names = await listDirectories(runsRoot);
  const stamped = await Promise.all(names.map(async (name) => {
    try {
      return { name, at: (await stat(path.join(runsRoot, name))).mtimeMs };
    } catch {
      return { name, at: 0 };
    }
  }));
  stamped.sort((left, right) => (left.at - right.at) || left.name.localeCompare(right.name));
  return stamped.map((entry) => entry.name);
}

function eventsByType(records) {
  const byType = new Map();
  for (const record of records) {
    const type = record.event?.type;
    if (typeof type !== "string") continue;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(record);
  }
  return byType;
}

function runStatusFrom(byType) {
  const settled = byType.get("run.settled")?.at(-1);
  if (settled) return settled.event.status ?? "completed";
  return byType.has("run.started") ? "running" : "unknown";
}

function taskStatusFrom(byType) {
  const settled = byType.get("dispatch.settled")?.at(-1);
  if (settled) return settled.event.execution?.ok === true ? "completed" : "failed";
  return byType.has("dispatch.started") ? "running" : "unknown";
}

/**
 * Mirrors `runStatusFrom` for dispatches that have no run-level writer. A task
 * that has started but not settled is `running`, so testing "every task
 * completed" reported a live agent as a failed run: it landed in the Failures
 * panel and was simultaneously missing from Active runs, which is precisely the
 * window a live dashboard exists to show.
 */
function synthesizedRunStatus(tasks) {
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "running")) return "running";
  return tasks.every((task) => task.status === "completed") ? "completed" : "unknown";
}

function collectRun({ runId, records }) {
  const byType = eventsByType(records);
  const started = byType.get("run.started")?.[0];
  const settled = byType.get("run.settled")?.at(-1);
  return {
    id: runId,
    kind: "run",
    name: runId,
    status: runStatusFrom(byType),
    startedAt: started?.timestamp ?? null,
    finishedAt: settled?.timestamp ?? null,
    concurrency: started?.event?.concurrency ?? null,
    taskCount: started?.event?.tasks?.length ?? 0,
    ...(settled?.event?.failedTask ? { failedTask: settled.event.failedTask } : {}),
  };
}

function collectTask({ runId, taskId, records }) {
  const byType = eventsByType(records);
  const started = byType.get("dispatch.started")?.[0];
  const settled = byType.get("dispatch.settled")?.at(-1);
  const worktree = byType.get("worktree.retained")?.at(-1)
    ?? byType.get("worktree.created")?.at(-1);
  const route = started?.event?.route;
  return {
    id: `${runId}/${taskId}`,
    kind: "task",
    name: taskId,
    runId,
    status: taskStatusFrom(byType),
    startedAt: started?.timestamp ?? null,
    finishedAt: settled?.timestamp ?? null,
    dispatches: byType.get("dispatch.started")?.length ?? 0,
    ...(route
      ? {
        project: route.projectId ?? null,
        workstream: route.workstreamId ?? null,
        role: route.roleId ?? null,
        agent: started?.event?.agent?.id ?? null,
      }
      : {}),
    ...(settled?.event?.execution
      ? {
        exitCode: settled.event.execution.exitCode ?? null,
        message: settled.event.execution.status ?? "",
      }
      : {}),
    ...(worktree?.event?.worktree
      ? { worktree: worktree.event.worktree.path, branch: worktree.event.worktree.branch }
      : {}),
  };
}

function collectReview({ runId, records }) {
  const settled = eventsByType(records).get("review.settled")?.at(-1);
  if (!settled) return null;
  return {
    id: runId,
    kind: "review",
    name: `${settled.event.producer ?? "?"} -> ${settled.event.reviewer ?? "?"}`,
    status: settled.event.status ?? "unknown",
    baseRef: settled.event.baseRef ?? null,
    headRef: settled.event.headRef ?? null,
    reviewedDiffHash: settled.event.reviewedDiffHash ?? null,
    timestamp: settled.timestamp,
  };
}

/**
 * Reads the project's own runtime records so `agent-trestle dashboard` works
 * inside an initialized project with no `--data` argument.
 */
export function createProjectDataProvider(projectRoot, options = {}) {
  const auditRoot = auditRootFor(projectRoot);
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  const reconcile = options.reconcile ?? reconcileAuditTask;

  return async () => {
    const runIds = await listRunsOldestFirst(path.join(auditRoot, "runs"));
    // Newest last, so the tail is the interesting end, and the cap keeps an
    // unbounded audit history from producing an unbounded page.
    const selected = runIds.slice(-maxRuns);

    const runs = [];
    const tasks = [];
    const reviews = [];
    const audit = [];
    const projects = new Map();
    const workstreams = new Map();

    for (const runId of selected) {
      const taskIds = await listDirectories(path.join(auditRoot, "runs", runId, "tasks"));
      for (const taskId of taskIds.sort()) {
        let reconciled;
        try {
          reconciled = await reconcile({ auditRoot, runId, taskId });
        } catch (error) {
          // A corrupt or tampered segment must be visible, not fatal: the
          // dashboard's job is to surface it.
          audit.push({
            id: `${runId}/${taskId}`,
            kind: "audit",
            name: `${runId}/${taskId}`,
            status: "failed",
            message: error.message,
          });
          continue;
        }

        audit.push({
          id: `${runId}/${taskId}`,
          kind: "audit",
          name: `${runId}/${taskId}`,
          status: "verified",
          segments: reconciled.segments.length,
          records: reconciled.records.length,
          reconciliationHash: reconciled.reconciliationHash,
        });

        if (reconciled.records.length === 0) continue;
        if (taskId === RUN_TASK_ID) {
          runs.push(collectRun({ runId, records: reconciled.records }));
          continue;
        }
        if (taskId === REVIEW_TASK_ID) {
          const review = collectReview({ runId, records: reconciled.records });
          if (review) reviews.push(review);
          continue;
        }
        if (taskId === FLEET_TASK_ID) continue;

        const task = collectTask({ runId, taskId, records: reconciled.records });
        tasks.push(task);
        if (task.project) {
          projects.set(task.project, { id: task.project, kind: "project", name: task.project });
        }
        if (task.workstream) {
          workstreams.set(task.workstream, {
            id: task.workstream,
            kind: "workstream",
            name: task.workstream,
            project: task.project ?? null,
          });
        }
      }

      // A dispatch invoked outside `run` has no run-level writer, so synthesize
      // one rather than dropping its tasks from the view.
      if (!runs.some((run) => run.id === runId)) {
        const owned = tasks.filter((task) => task.runId === runId);
        if (owned.length > 0) {
          runs.push({
            id: runId,
            kind: "run",
            name: runId,
            status: synthesizedRunStatus(owned),
            startedAt: owned[0].startedAt,
            finishedAt: owned.at(-1).finishedAt,
            taskCount: owned.length,
          });
        }
      }
    }

    // The normalizer *rejects* an oversized collection rather than trimming it,
    // and `audit` grows by one entry per (run, task) pair with nothing capping
    // it -- 50 runs of 21 tasks is already 1050. Left unchecked the provider
    // throws, the server turns that into a blanket 500, and because history only
    // grows the dashboard never recovers. Trim to the tail (most recent) here.
    const maxItems = options.limits?.maxItems ?? DEFAULT_LIMITS.maxItems;
    const trim = (entries) => (entries.length > maxItems ? entries.slice(-maxItems) : entries);

    return normalizeDashboardModel({
      projects: trim([...projects.values()]),
      workstreams: trim([...workstreams.values()]),
      runs: trim(runs),
      tasks: trim(tasks),
      reviews: trim(reviews),
      audit: trim(audit),
      generatedAt: new Date().toISOString(),
    }, options.limits);
  };
}
