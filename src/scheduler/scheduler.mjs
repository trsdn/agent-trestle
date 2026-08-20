import { normalizeTasks, readyTasks } from "./dag.mjs";
import { decideStop } from "./stop-decisions.mjs";
import { readWorkSignature } from "./work-signature.mjs";

export async function runTaskGraph({
  tasks,
  concurrency = 1,
  context = {},
  signal,
  failureSettlementMs = 1_000,
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  if (!Number.isFinite(failureSettlementMs) || failureSettlementMs < 0) {
    throw new RangeError("failureSettlementMs must be a non-negative finite number");
  }
  const byId = normalizeTasks(tasks);
  const states = new Map([...byId.keys()].map((id) => [id, "pending"]));
  const results = new Map();
  const running = new Map();
  const controller = new AbortController();
  const abortExternal = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortExternal();
  else signal?.addEventListener("abort", abortExternal, { once: true });

  const record = (settled) => {
    running.delete(settled.id);
    states.set(settled.id, settled.status);
    results.set(
      settled.id,
      settled.status === "completed" ? settled.value : settled.error,
    );
  };

  const start = (task) => {
    states.set(task.id, "running");
    const promise = Promise.resolve()
      .then(() => {
        signal?.throwIfAborted();
        controller.signal.throwIfAborted();
        return task.run({ ...context, task, signal: controller.signal, results });
      })
      .then(
        (value) => ({ id: task.id, status: "completed", value }),
        (error) => ({ id: task.id, status: "failed", error }),
      );
    running.set(task.id, promise);
  };

  while (running.size || [...states.values()].includes("pending")) {
    for (const task of readyTasks(byId, states)) {
      if (running.size >= concurrency) break;
      start(task);
    }
    if (running.size === 0) {
      const blocked = [...states]
        .filter(([, state]) => state === "pending")
        .map(([id]) => id);
      return { status: "blocked", states, results, blocked };
    }
    const settled = await Promise.race(running.values());
    record(settled);
    if (settled.status === "failed") {
      controller.abort(settled.error);
      const remaining = [...running.entries()];
      const settledById = new Map();
      const tracked = remaining.map(([id, promise]) => promise.then((result) => {
        settledById.set(id, result);
        return result;
      }));
      let failureSettlementTimer;
      const settlementTimeout = new Promise((resolve) => {
        failureSettlementTimer = setTimeout(() => resolve(null), failureSettlementMs);
      });
      let terminal;
      try {
        terminal = await Promise.race([Promise.all(tracked), settlementTimeout]);
      } finally {
        clearTimeout(failureSettlementTimer);
      }
      if (terminal) {
        for (const result of terminal) record(result);
      } else {
        for (const [id] of remaining) {
          if (!running.has(id)) continue;
          const settledResult = settledById.get(id);
          if (settledResult) {
            record(settledResult);
            continue;
          }
          const error = new Error(
            `task ${id} did not settle after sibling failure`,
          );
          error.code = "SIBLING_SETTLEMENT_TIMEOUT";
          states.set(id, "failed");
          results.set(id, error);
          running.delete(id);
        }
      }
      return {
        status: "failed",
        failedTask: settled.id,
        error: settled.error,
        states,
        results,
      };
    }
  }
  return { status: "completed", states, results };
}

export async function runSequential(options = {}) {
  return runTaskGraph({ ...options, concurrency: 1 });
}

export async function runRounds({
  runRound,
  workSignatureProvider,
  isComplete = (result) => result?.completed === true,
  maxRounds = Infinity,
  maxDurationMs = Infinity,
  maxNoOpRounds = 1,
  clock = () => Date.now(),
  context = {},
  signal,
} = {}) {
  if (typeof runRound !== "function") throw new TypeError("runRound is required");
  const startedAt = clock();
  let previousSignature = await readWorkSignature(workSignatureProvider, {
    ...context,
    phase: "initial",
  });
  let noOpRounds = 0;
  const rounds = [];

  for (let round = 1; ; round += 1) {
    const before = decideStop({
      roundsCompleted: rounds.length,
      maxRounds,
      elapsedMs: clock() - startedAt,
      maxDurationMs,
    });
    if (before.stop) return { ...before, rounds };

    signal?.throwIfAborted();
    const result = await runRound({ ...context, round, signal });
    rounds.push(result);
    const currentSignature = await readWorkSignature(workSignatureProvider, {
      ...context,
      phase: "after-round",
      round,
      result,
    });
    const decision = decideStop({
      completed: isComplete(result),
      previousSignature,
      currentSignature,
      noOpRounds,
      maxNoOpRounds,
      roundsCompleted: rounds.length,
      maxRounds,
      elapsedMs: clock() - startedAt,
      maxDurationMs,
    });
    if (decision.stop) {
      return { ...decision, rounds, signature: currentSignature };
    }
    noOpRounds = decision.noOpRounds;
    previousSignature = currentSignature;
  }
}
