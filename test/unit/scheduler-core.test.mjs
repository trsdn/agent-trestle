import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkSignatureProvider,
  decideStop,
  runRounds,
  runSequential,
  runTaskGraph,
} from "../../src/scheduler/index.mjs";

test("sequential scheduling respects dependencies and insertion order", async () => {
  const order = [];
  const result = await runSequential({
    tasks: [
      { id: "a", run: async () => order.push("a") },
      { id: "b", dependsOn: ["a"], run: async () => order.push("b") },
      { id: "c", dependsOn: ["b"], run: async () => order.push("c") },
    ],
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("DAG scheduler bounds concurrency", async () => {
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 6 }, (_, index) => ({
    id: `task-${index}`,
    run: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    },
  }));
  const result = await runTaskGraph({ tasks, concurrency: 2 });
  assert.equal(result.status, "completed");
  assert.equal(peak, 2);
});

test("DAG scheduler records all running terminal outcomes before returning a failure", async () => {
  let releaseSuccess;
  let releaseFailure;
  const successGate = new Promise((resolve) => { releaseSuccess = resolve; });
  const failureGate = new Promise((resolve) => { releaseFailure = resolve; });
  let dependentRan = false;

  const run = runTaskGraph({
    concurrency: 3,
    tasks: [
      {
        id: "required-failure",
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error("required task failed");
        },
      },
      {
        id: "concurrent-success",
        run: async () => {
          await successGate;
          return "completed while draining";
        },
      },
      {
        id: "concurrent-failure",
        run: async () => {
          await failureGate;
          throw new Error("also failed");
        },
      },
      {
        id: "dependent",
        dependsOn: ["required-failure"],
        run: async () => { dependentRan = true; },
      },
    ],
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseSuccess();
  releaseFailure();
  const result = await run;

  assert.equal(result.status, "failed");
  assert.equal(result.failedTask, "required-failure");
  assert.equal(result.states.get("required-failure"), "failed");
  assert.equal(result.states.get("concurrent-success"), "completed");
  assert.equal(result.states.get("concurrent-failure"), "failed");
  assert.equal(result.states.get("dependent"), "pending");
  assert.equal(result.results.get("concurrent-success"), "completed while draining");
  assert.match(result.results.get("concurrent-failure").message, /also failed/);
  assert.equal(dependentRan, false);
});

test("DAG scheduler aborts siblings and bounds a non-settling failure drain", async () => {
  const startedAt = Date.now();
  let aborted = false;
  const result = await runTaskGraph({
    concurrency: 3,
    failureSettlementMs: 25,
    tasks: [
      {
        id: "failure",
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error("first failure");
        },
      },
      {
        id: "cooperative",
        run: async ({ signal }) => new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve("aborted");
          }, { once: true });
        }),
      },
      {
        id: "never",
        run: async () => new Promise(() => {}),
      },
    ],
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failedTask, "failure");
  assert.equal(result.states.get("failure"), "failed");
  assert.equal(result.states.get("cooperative"), "completed");
  assert.equal(result.states.get("never"), "failed");
  assert.equal(result.results.get("never").code, "SIBLING_SETTLEMENT_TIMEOUT");
  assert.equal(aborted, true);
  assert.ok(Date.now() - startedAt < 500, "failure settlement must remain bounded");
});

test("DAG scheduler clears a fast failure-settlement timer", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let settlementTimer;
  let cleared = false;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = originalSetTimeout(callback, delay, ...args);
    if (delay === 500) settlementTimer = handle;
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle === settlementTimer) cleared = true;
    return originalClearTimeout(handle);
  };
  try {
    const result = await runTaskGraph({
      concurrency: 2,
      failureSettlementMs: 500,
      tasks: [
        { id: "failure", run: async () => { throw new Error("first failure"); } },
        { id: "fast-sibling", run: async () => "settled" },
      ],
    });
    assert.equal(result.status, "failed");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.ok(settlementTimer, "the failure-settlement timer must be created");
  assert.equal(cleared, true, "fast sibling settlement must clear the timer");
});

test("DAG validation rejects cycles and unknown dependencies", async () => {
  await assert.rejects(
    runTaskGraph({
      tasks: [
        { id: "a", dependsOn: ["b"], run() {} },
        { id: "b", dependsOn: ["a"], run() {} },
      ],
    }),
    /cycle/,
  );
  await assert.rejects(
    runTaskGraph({
      tasks: [{ id: "a", dependsOn: ["missing"], run() {} }],
    }),
    /unknown dependency/,
  );
});

test("stop decisions are pure and prioritize completion", () => {
  const input = {
    completed: true,
    elapsedMs: 10,
    maxDurationMs: 1,
    roundsCompleted: 10,
    maxRounds: 1,
  };
  assert.deepEqual(decideStop(input), { stop: true, reason: "complete" });
  assert.deepEqual(input, {
    completed: true,
    elapsedMs: 10,
    maxDurationMs: 1,
    roundsCompleted: 10,
    maxRounds: 1,
  });
});

test("round scheduler stops after configured no-op signatures", async () => {
  let calls = 0;
  const provider = createWorkSignatureProvider(async () => "same");
  const result = await runRounds({
    workSignatureProvider: provider,
    maxNoOpRounds: 2,
    maxRounds: 10,
    runRound: async () => {
      calls += 1;
      return { completed: false };
    },
  });
  assert.equal(result.reason, "no-op");
  assert.equal(calls, 2);
});

test("round scheduler enforces max rounds and duration", async () => {
  let signature = 0;
  const provider = createWorkSignatureProvider(async () => String(signature++));
  const rounds = await runRounds({
    workSignatureProvider: provider,
    maxRounds: 2,
    runRound: async () => ({}),
  });
  assert.equal(rounds.reason, "max-rounds");
  assert.equal(rounds.rounds.length, 2);

  const duration = await runRounds({
    workSignatureProvider: provider,
    maxDurationMs: 0,
    runRound: async () => assert.fail("must not run"),
  });
  assert.equal(duration.reason, "max-duration");
});
