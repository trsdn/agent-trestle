import { spawn } from "node:child_process";
import { superviseChildProcess } from "../process/live-child-supervisor.mjs";

const SUPPORTS_PROCESS_GROUP_KILL = process.platform !== "win32";

export function createGitProcessAdapter({
  spawnImpl = spawn,
  terminationGraceMs = 1_000,
  forcedKillSettlementMs = 1_000,
} = {}) {
  return {
    run({ repoRoot, args, timeoutMs = 30_000 }) {
      return new Promise((resolve, reject) => {
        const useProcessGroupKill = SUPPORTS_PROCESS_GROUP_KILL;
        const child = spawnImpl("git", ["-C", repoRoot, ...args], {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          detached: useProcessGroupKill,
        });
        const supervision = superviseChildProcess(child, { detached: useProcessGroupKill });
        const stdout = [];
        const stderr = [];
        let settled = false;
        let timedOut = false;
        let timeoutTimer;
        let terminationTimer;
        let settlementTimer;
        const clearTimers = () => {
          clearTimeout(timeoutTimer);
          clearTimeout(terminationTimer);
          clearTimeout(settlementTimer);
        };
        const result = (code = null, signal = null) => ({
          code,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
        const timeoutError = (code = null, signal = null) => {
          const error = new Error("git timed out");
          error.code = "TIMEOUT";
          error.result = result(code, signal);
          return error;
        };
        const settle = (callback) => {
          if (settled) return;
          settled = true;
          clearTimers();
          supervision.unregister();
          callback();
        };
        // Signals the whole POSIX process group (not just the direct git
        // process) so a git hook or filter that forks a helper process
        // cannot outlive termination; falls back to direct child signaling
        // when group signaling is unavailable (Windows, or a pid that no
        // longer identifies a live group). The direct fallback only fires
        // when the group signal was not attempted or did not go through: the
        // child is itself a member of its own process group, so a successful
        // group signal already reaches it, and also signaling it directly
        // would deliver the same signal twice.
        const kill = (signal) => {
          supervision.signal(signal);
        };
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.on("error", (error) => {
          settle(() => reject(timedOut ? timeoutError() : error));
        });
        child.on("close", (code, signal) => {
          settle(() => {
            if (timedOut) {
              reject(timeoutError(code, signal));
            } else if (code === 0) {
              resolve(result(code, signal));
            } else {
              const error = new Error(`git exited with code ${code ?? signal}`);
              error.result = result(code, signal);
              reject(error);
            }
          });
        });
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          kill("SIGTERM");
          terminationTimer = setTimeout(() => {
            kill("SIGKILL");
            settlementTimer = setTimeout(() => {
              settle(() => reject(timeoutError(null, "SIGKILL")));
            }, forcedKillSettlementMs);
          }, terminationGraceMs);
        }, timeoutMs);
      });
    },
  };
}
