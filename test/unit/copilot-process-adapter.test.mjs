import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeScratchRoot } from "../helpers/scratch.mjs";
import {
  inspectModelLog,
  runCopilot,
  spawnProcess,
} from "../../src/copilot/process-adapter.mjs";

const scratchRoot = await makeScratchRoot("copilot-process-adapter");
const fixtureRoot = path.join(scratchRoot, "fake-copilot");
const processTreeRoot = path.join(scratchRoot, "copilot-process-tree");

async function fakeCopilot(mode, { modelLog } = {}) {
  await mkdir(fixtureRoot, { recursive: true });
  const script = path.join(fixtureRoot, `${mode}.mjs`);
  const source = {
    success: "process.stdout.write('completed');",
    failure: "process.stderr.write('rejected'); process.exitCode = 23;",
    signal: "process.kill(process.pid, 'SIGTERM');",
    timeout: "setInterval(() => {}, 1000);",
    flood: "process.stdout.write('x'.repeat(2_000_000)); setInterval(() => {}, 1000);",
    argecho:
      "for (const a of process.argv.slice(2)) process.stderr.write('ARG>>>' + a + '<<<\\n'); process.exitCode = 5;",
  }[mode];
  await writeFile(script, `#!/usr/bin/env node\n${source}\n`);
  await chmod(script, 0o755);
  if (modelLog !== undefined) {
    await writeFile(path.join(fixtureRoot, `${mode}.log`), modelLog);
  }
  return script;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function markerSize(markerPath) {
  try {
    return Buffer.byteLength(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

test.after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  await rm(processTreeRoot, { recursive: true, force: true });
});

test("spawn adapter preserves actual exit code and output", async () => {
  const result = await spawnProcess(process.execPath, [
    "-e",
    "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)",
  ]);
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.equal(result.error, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
});

test("spawn adapter reports timeout and the actual termination signal", async () => {
  const result = await spawnProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { timeoutMs: 25 },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGTERM");
});

// The timeout has to outlast the child's interpreter startup, or SIGTERM
// arrives before the handler below is installed, the default disposition
// terminates the process, and the escalation under test never happens.
// Startup was measured at 18 ms median and 35 ms worst case on an idle
// machine, and is unbounded on a loaded CI runner; the process-tree test in
// this file has used 700 ms without flaking, so match it.
test("spawn adapter escalates to SIGKILL when a timed-out process ignores SIGTERM", async () => {
  const startedAt = Date.now();
  const result = await spawnProcess(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => process.stdout.write('term-ignored')); setInterval(() => {}, 1000)",
    ],
    { timeoutMs: 700, killGraceMs: 50 },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.stdout, "term-ignored");
  // Bounds the escalation, not the runner: the assertion above already proves
  // SIGKILL followed SIGTERM, so this only has to exclude an unbounded wait.
  assert.ok(Date.now() - startedAt < 5_000);
});

test(
  "spawn adapter timeout stops a spawned grandchild writer via process-tree termination",
  { skip: process.platform === "win32" ? "requires POSIX process groups" : false },
  async () => {
    await rm(processTreeRoot, { recursive: true, force: true });
    await mkdir(processTreeRoot, { recursive: true });
    const markerPath = path.join(processTreeRoot, `marker-${process.pid}-${Date.now()}.log`);
    const childPidPath = path.join(processTreeRoot, `grandchild-${process.pid}-${Date.now()}.pid`);
    const grandchildSource = [
      "const { appendFileSync, writeFileSync } = require('node:fs');",
      "const markerPath = process.argv[1];",
      "const pidPath = process.argv[2];",
      "writeFileSync(pidPath, String(process.pid));",
      "appendFileSync(markerPath, 'start\\n');",
      "setInterval(() => appendFileSync(markerPath, 'tick\\n'), 20);",
    ].join("\n");
    const parentSource = [
      "const { spawn } = require('node:child_process');",
      "const markerPath = process.argv[1];",
      "const pidPath = process.argv[2];",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}, markerPath, pidPath], { stdio: 'ignore' });`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    try {
      const result = await spawnProcess(
        process.execPath,
        ["-e", parentSource, markerPath, childPidPath],
        { timeoutMs: 700, killGraceMs: 100, forcedKillSettlementMs: 300 },
      );
      assert.equal(result.timedOut, true);
      assert.equal(result.signal, "SIGKILL");
      let firstSize = 0;
      for (let attempt = 0; attempt < 20 && firstSize === 0; attempt += 1) {
        await sleep(100);
        firstSize = await markerSize(markerPath);
      }
      assert.ok(firstSize > 0, "grandchild marker writes must start before termination");
      await sleep(250);
      const secondSize = await markerSize(markerPath);
      assert.equal(secondSize, firstSize, "marker writes must stop after process-tree termination");
    } finally {
      try {
        const pid = Number((await readFile(childPidPath, "utf8")).trim());
        if (Number.isInteger(pid) && pid > 1) {
          process.kill(pid, "SIGKILL");
        }
      } catch {
        // best-effort test cleanup
      }
      await rm(processTreeRoot, { recursive: true, force: true });
    }
  },
);

test("spawn adapter stops a process that floods stdout past the configured cap without buffering it", async () => {
  const startedAt = Date.now();
  const result = await spawnProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(2_000_000)); setInterval(() => {}, 1000);"],
    { timeoutMs: 5_000, maxStdoutBytes: 1_000, killGraceMs: 50, forcedKillSettlementMs: 200 },
  );
  assert.equal(result.outputExceeded, "stdout");
  assert.equal(result.error?.code, "OUTPUT_LIMIT");
  assert.ok(Buffer.byteLength(result.stdout) <= 1_000, "buffered stdout must not exceed the cap");
  assert.ok(
    Date.now() - startedAt < 2_000,
    "a flooding process must be reaped by the output cap, not run to timeoutMs",
  );
});

test("spawn adapter stops a process that floods stderr past the configured cap without buffering it", async () => {
  const result = await spawnProcess(
    process.execPath,
    ["-e", "process.stderr.write('x'.repeat(2_000_000)); setInterval(() => {}, 1000);"],
    { timeoutMs: 5_000, maxStderrBytes: 1_000, killGraceMs: 50, forcedKillSettlementMs: 200 },
  );
  assert.equal(result.outputExceeded, "stderr");
  assert.equal(result.error?.code, "OUTPUT_LIMIT");
  assert.ok(Buffer.byteLength(result.stderr) <= 1_000, "buffered stderr must not exceed the cap");
});

test("runCopilot reports a structured output-limit failure for a Copilot binary that floods stdout", async () => {
  const result = await runCopilot({
    prompt: "Perform deterministic test work",
    agent: "test-agent",
    cwd: fixtureRoot,
    binary: await fakeCopilot("flood"),
    maxStdoutBytes: 2_000,
    killGraceMs: 50,
    forcedKillSettlementMs: 200,
  });
  assert.equal(result.status, "output-limit");
  assert.equal(result.ok, false);
  assert.equal(result.outputExceeded, "stdout");
  assert.equal(result.error?.code, "OUTPUT_LIMIT");
  assert.ok(Buffer.byteLength(result.stdout) <= 2_000, "buffered stdout must not exceed the cap");
});

test("spawn adapter preserves spawn errors", async () => {
  const expected = new Error("cannot spawn");
  const result = await spawnProcess("copilot", [], {
    spawnImpl() {
      throw expected;
    },
  });
  assert.equal(result.error, expected);
  assert.equal(result.exitCode, null);
});

test("runCopilot accepts injectable binary and runner and returns a structured result", async () => {
  let received;
  const result = await runCopilot({
    prompt: "Do work",
    agent: "builder",
    model: "gpt-test",
    cwd: "/project/workstream",
    binary: "test-copilot",
    args: ["--no-ask-user"],
    killGraceMs: 75,
    runner: async (spec) => {
      received = spec;
      return {
        exitCode: 0,
        signal: null,
        error: null,
        timedOut: false,
        stdout: "done",
        stderr: "",
      };
    },
  });
  assert.equal(received.binary, "test-copilot");
  assert.deepEqual(received.args, [
    "--agent", "builder",
    "--model", "gpt-test",
    "--no-ask-user",
    "-p", "Do work",
  ]);
  assert.equal(received.killGraceMs, 75);
  assert.equal(result.status, "succeeded");
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.args, [
    "--agent", "builder",
    "--model", "gpt-test",
    "--no-ask-user",
    "-p", "[REDACTED]",
  ]);
});

test("runCopilot redacts prompt canaries from returned args, output, and errors", async () => {
  const prompt = "PROMPT_CANARY_7f3a";
  const result = await runCopilot({
    prompt,
    agent: "-p",
    cwd: "/project/workstream",
    runner: async () => {
      const error = new Error(`child echoed ${prompt}`);
      error.spawnargs = ["--agent", "-p", "-p", prompt];
      throw error;
    },
  });
  assert.equal(result.status, "error");
  assert.equal(result.error.message.includes(prompt), false);
  assert.equal(result.args.includes(prompt), false);
  assert.equal(result.args.at(-1), "[REDACTED]");
  assert.equal(result.error.spawnargs.includes(prompt), false);
  assert.equal(result.error.spawnargs.at(-1), "[REDACTED]");

  const returned = await runCopilot({
    prompt,
    agent: "builder",
    cwd: "/project/workstream",
    runner: async () => ({
      exitCode: 1,
      signal: null,
      error: null,
      timedOut: false,
      outputExceeded: null,
      stdout: prompt,
      stderr: `spawnargs=${prompt}`,
      spawnargs: ["-p", prompt],
    }),
  });
  assert.equal(returned.stdout.includes(prompt), false);
  assert.equal(returned.stderr.includes(prompt), false);
  assert.equal(returned.spawnargs.includes(prompt), false);

  const errorWithSpawnargs = await runCopilot({
    prompt,
    agent: "builder",
    cwd: "/project/workstream",
    runner: async () => {
      const error = new Error("spawn failed");
      error.spawnargs = ["-p", prompt];
      throw error;
    },
  });
  assert.equal(errorWithSpawnargs.error.spawnargs.includes(prompt), false);
});

test("runCopilot redacts the trailing prompt from a real spawned reviewer echoing its own argv, even when agent equals -p", async () => {
  const prompt = "REAL_SPAWN_RUNCOPILOT_CANARY_4d7c";
  const result = await runCopilot({
    prompt,
    agent: "-p",
    cwd: fixtureRoot,
    binary: await fakeCopilot("argecho"),
    timeoutMs: 5_000,
  });
  assert.equal(result.exitCode, 5);
  assert.equal(result.stderr.includes(prompt), false, "the real prompt must never appear in reviewer output");
  assert.ok(result.stderr.includes("ARG>>>[REDACTED]<<<"), "the trailing prompt argv slot must be redacted");
  // The earlier "-p" contributed by the agent id must survive untouched; only
  // the genuine trailing flag pair (right before the prompt) is a target.
  assert.equal((result.stderr.match(/ARG>>>-p<<</g) ?? []).length, 2);
  assert.equal(result.args.includes(prompt), false);
  assert.equal(result.args.at(-1), "[REDACTED]");
});

test("runCopilot recursively redacts a prompt canary buried in nested causes, including a non-object string cause", async () => {
  const prompt = "NESTED_CAUSE_CANARY_5e9d";
  const deepest = `curl exited referencing ${prompt}`; // a plain string cause, not an Error
  const middle = new Error("retry failed, nothing sensitive in this message");
  middle.cause = deepest;
  const outer = new Error("spawn ultimately failed, nothing sensitive in this message either");
  outer.cause = middle;

  const result = await runCopilot({
    prompt,
    agent: "builder",
    cwd: "/project/workstream",
    runner: async () => { throw outer; },
  });

  assert.equal(result.status, "error");
  assert.equal(result.error.message.includes(prompt), false);
  assert.equal(result.error.cause.message.includes(prompt), false);
  assert.equal(typeof result.error.cause.cause, "string");
  assert.equal(result.error.cause.cause.includes(prompt), false);
  assert.match(result.error.cause.cause, /\[REDACTED\]/);
});

test("runCopilot breaks a circular error cause chain instead of recursing forever", async () => {
  const prompt = "CYCLE_CANARY_RUNCOPILOT";
  const a = new Error(`a failed with ${prompt}`);
  const b = new Error("b failed");
  a.cause = b;
  b.cause = a;

  const result = await runCopilot({
    prompt,
    agent: "builder",
    cwd: "/project/workstream",
    runner: async () => { throw a; },
  });

  assert.equal(result.error.message.includes(prompt), false);
  assert.equal(result.error.cause.message, "b failed");
  assert.equal(result.error.cause.cause, undefined);
});

test("model log inspection is diagnostic and never changes process success", async () => {
  const result = await runCopilot({
    prompt: "Do work",
    agent: "builder",
    model: "expected-model",
    cwd: "/project",
    runner: async () => ({
      exitCode: 0,
      signal: null,
      error: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    }),
    modelLogPath: "/diagnostic.log",
    readFileImpl: async () => "model=other-model",
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics[0].code, "model-log-mismatch");
  assert.deepEqual(inspectModelLog("model: expected-model", "expected-model"), null);
  assert.deepEqual(inspectModelLog('{"model":"expected-model"}', "expected-model"), null);
});

test("runner failures are returned as structured process errors", async () => {
  const expected = new Error("runner failed");
  const result = await runCopilot({
    prompt: "Do work",
    agent: "builder",
    cwd: "/project",
    runner: async () => { throw expected; },
  });
  assert.equal(result.status, "error");
  assert.equal(result.ok, false);
  assert.equal(result.error, expected);
});

test("fake Copilot executable reports success, failure, signal, timeout, and wrong-model diagnostics", async () => {
  const common = {
    prompt: "Perform deterministic test work",
    agent: "test-agent",
    model: "expected-model",
    cwd: fixtureRoot,
  };
  const success = await runCopilot({
    ...common,
    binary: await fakeCopilot("success", { modelLog: "model=other-model" }),
    modelLogPath: path.join(fixtureRoot, "success.log"),
  });
  assert.equal(success.status, "succeeded");
  assert.equal(success.stdout, "completed");
  assert.equal(success.diagnostics[0].code, "model-log-mismatch");
  assert.equal(success.diagnostics[0].observedModel, "other-model");

  const failure = await runCopilot({ ...common, binary: await fakeCopilot("failure") });
  assert.equal(failure.status, "failed");
  assert.equal(failure.exitCode, 23);
  assert.equal(failure.stderr, "rejected");

  const signaled = await runCopilot({ ...common, binary: await fakeCopilot("signal") });
  assert.equal(signaled.status, "signaled");
  assert.equal(signaled.signal, "SIGTERM");

  const timedOut = await runCopilot({
    ...common,
    binary: await fakeCopilot("timeout"),
    timeoutMs: 30,
  });
  assert.equal(timedOut.status, "timeout");
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.signal, "SIGTERM");
});

test("real Copilot smoke test is explicitly environment gated", {
  skip: process.env.TRESTLE_REAL_COPILOT_SMOKE !== "1"
    ? "set TRESTLE_REAL_COPILOT_SMOKE=1 and TRESTLE_REAL_COPILOT_AGENT to enable"
    : false,
  timeout: 120_000,
}, async () => {
  assert.ok(process.env.TRESTLE_REAL_COPILOT_AGENT, "TRESTLE_REAL_COPILOT_AGENT is required");
  const result = await runCopilot({
    prompt: "Reply with exactly TRESTLE_SMOKE_OK and do not use tools.",
    agent: process.env.TRESTLE_REAL_COPILOT_AGENT,
    model: process.env.TRESTLE_REAL_COPILOT_MODEL,
    cwd: path.resolve("."),
    timeoutMs: 90_000,
  });
  assert.equal(result.status, "succeeded", result.stderr);
  assert.match(result.stdout, /TRESTLE_SMOKE_OK/);
});
