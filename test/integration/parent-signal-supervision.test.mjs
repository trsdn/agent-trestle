import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeScratchRoot } from "../helpers/scratch";

const repoRoot = path.resolve(".");
const fixtureRoot = await makeScratchRoot("parent-signal-supervision");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filename, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filename, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await sleep(25);
    }
  }
  throw new Error(`timed out waiting for ${filename}`);
}

async function markerSize(filename) {
  return Buffer.byteLength(await readFile(filename, "utf8"));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForStopped(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await sleep(25);
  }
  assert.fail(`process ${pid} remained alive`);
}

test(
  "CLI SIGINT stops detached Copilot descendants before preserving SIGINT exit semantics",
  { skip: process.platform === "win32" ? "requires POSIX detached process groups" : false, timeout: 10_000 },
  async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
    const projectRoot = path.join(fixtureRoot, "project");
    const workstreamRoot = path.join(projectRoot, "work");
    const markerPath = path.join(fixtureRoot, "marker.log");
    const childPidPath = path.join(fixtureRoot, "child.pid");
    const grandchildPidPath = path.join(fixtureRoot, "grandchild.pid");
    const fakeCopilotPath = path.join(fixtureRoot, "fake-copilot.mjs");
    await mkdir(path.join(projectRoot, ".trestle"), { recursive: true });
    await mkdir(path.join(projectRoot, ".github", "agents"), { recursive: true });
    await mkdir(workstreamRoot, { recursive: true });

    await writeFile(path.join(projectRoot, ".trestle", "config.json"), `${JSON.stringify({
      version: 1,
      project: { id: "signal-test" },
      permissions: {
        allowAllTools: false,
        allowAllPaths: false,
        allowAllUrls: false,
        nonInteractive: false,
        autoMerge: false,
      },
      copilot: { timeoutMs: 30_000 },
      workstreams: [{
        id: "main",
        path: "work",
        roles: [{ id: "builder", agent: "signal-builder" }],
      }],
    })}\n`);
    await writeFile(
      path.join(projectRoot, ".github", "agents", "signal-builder.agent.md"),
      "---\nmodel: test-model\nskills: []\n---\n\nSignal integration fixture.\n",
    );

    const grandchildSource = [
      "const { appendFileSync, writeFileSync } = require('node:fs');",
      "writeFileSync(process.env.TRESTLE_GRANDCHILD_PID, String(process.pid));",
      "appendFileSync(process.env.TRESTLE_MARKER, 'start\\n');",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => appendFileSync(process.env.TRESTLE_MARKER, 'tick\\n'), 20);",
    ].join("\n");
    await writeFile(fakeCopilotPath, [
      "#!/usr/bin/env node",
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.TRESTLE_CHILD_PID, String(process.pid));",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: 'ignore', env: process.env });`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await chmod(fakeCopilotPath, 0o755);

    let cli;
    let childPid;
    let grandchildPid;
    try {
      cli = spawn(process.execPath, [
        path.join(repoRoot, "src/cli/agent-trestle.mjs"),
        "dispatch",
        "--root", projectRoot,
        "--project", "signal-test",
        "--workstream", "main",
        "--role", "builder",
        "--prompt", "Wait for SIGINT",
        "--binary", fakeCopilotPath,
        "--json",
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          TRESTLE_MARKER: markerPath,
          TRESTLE_CHILD_PID: childPidPath,
          TRESTLE_GRANDCHILD_PID: grandchildPidPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      childPid = Number((await waitForFile(childPidPath)).trim());
      grandchildPid = Number((await waitForFile(grandchildPidPath)).trim());
      await waitForFile(markerPath);
      assert.ok(processIsAlive(cli.pid));
      assert.ok(processIsAlive(childPid));
      assert.ok(processIsAlive(grandchildPid));

      const closed = new Promise((resolve, reject) => {
        cli.once("error", reject);
        cli.once("close", (code, signal) => resolve({ code, signal }));
      });
      cli.kill("SIGINT");
      assert.deepEqual(await closed, { code: null, signal: "SIGINT" });

      await waitForStopped(childPid);
      await waitForStopped(grandchildPid);
      const stoppedSize = await markerSize(markerPath);
      await sleep(250);
      assert.equal(
        await markerSize(markerPath),
        stoppedSize,
        "no descendant may write markers after parent signal cleanup",
      );
    } finally {
      for (const pid of [cli?.pid, childPid, grandchildPid]) {
        if (Number.isInteger(pid) && pid > 1 && processIsAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // best-effort cleanup
          }
        }
      }
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  },
);
