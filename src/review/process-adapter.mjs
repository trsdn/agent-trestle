import { spawn } from "node:child_process";
import { superviseChildProcess } from "../process/live-child-supervisor.mjs";

// A single argv element must stay comfortably under the smallest common OS
// per-argument ceiling (Linux MAX_ARG_STRLEN is 128 KiB). Reviewer prompts are
// passed as one `-p <prompt>` argument, so we cap well below that limit and fail
// deterministically instead of letting the kernel raise E2BIG at spawn time.
export const SAFE_ARG_BYTES = 96 * 1024;
const SUPPORTS_PROCESS_GROUP_KILL = process.platform !== "win32";

// The reviewer prompt is always the final argv pair (`-p`/`--prompt` followed
// by the prompt text; see buildReadOnlyReviewerCommand). Reading only that
// trailing position - instead of scanning for any "-p"/"--prompt"-looking
// value anywhere in argv - means an earlier flag value that happens to equal
// "-p" (e.g. a reviewer/agent id of "-p") can never be mistaken for the real
// prompt flag, which would otherwise redact the wrong text and let the true
// prompt leak through untouched.
function promptFromArgs(args) {
  const values = Array.isArray(args) ? args : [];
  const flagIndex = values.length - 2;
  const flag = values[flagIndex];
  const value = values[values.length - 1];
  return (flag === "-p" || flag === "--prompt") && typeof value === "string" ? value : null;
}

export function redactSecret(value, secret) {
  if (typeof value !== "string" || typeof secret !== "string" || secret === "") return value;
  return value.split(secret).join("[REDACTED]");
}

// Recurses through the full `cause` chain regardless of shape: a string cause
// is redacted directly, an object (Error or plain) cause is rebuilt through
// this same function, and anything else passes through unchanged. `seen`
// breaks a circular cause chain (never expected in practice, but cheap to
// guard) by dropping the repeated node rather than looping forever.
export function sanitizeProcessError(error, secret, seen = new WeakSet()) {
  if (typeof error === "string") return redactSecret(error, secret);
  if (!error || typeof error !== "object") return error;
  if (seen.has(error)) return undefined;
  seen.add(error);
  const sanitized = new Error(redactSecret(error.message, secret));
  sanitized.name = error.name;
  if (error.code !== undefined) sanitized.code = error.code;
  if (error.signal !== undefined) sanitized.signal = error.signal;
  if (Array.isArray(error.args)) {
    sanitized.args = error.args.map((arg) => redactSecret(arg, secret));
  }
  if (Array.isArray(error.spawnargs)) {
    sanitized.spawnargs = error.spawnargs.map((arg) => redactSecret(arg, secret));
  }
  if (error.result !== undefined) {
    sanitized.result = sanitizeProcessResult(error.result, secret);
  }
  if (error.cause !== undefined) sanitized.cause = sanitizeProcessError(error.cause, secret, seen);
  return sanitized;
}

export function sanitizeProcessResult(result, secret) {
  const redactArgs = (args) => Array.isArray(args)
    ? args.map((arg) => redactSecret(arg, secret))
    : args;
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    stdout: redactSecret(result.stdout, secret),
    stderr: redactSecret(result.stderr, secret),
    command: redactSecret(result.command, secret),
    args: redactArgs(result.args),
    spawnargs: redactArgs(result.spawnargs),
  };
}

function measureArgv(executable, args) {
  let total = Buffer.byteLength(String(executable)) + 1;
  let largest = 0;
  for (const arg of args) {
    const size = Buffer.byteLength(String(arg));
    total += size + 1;
    if (size > largest) largest = size;
  }
  return { total, largest };
}

function normalizeArgError(error) {
  if (error && (error.code === "E2BIG" || error.code === "ENAMETOOLONG")) {
    error.code = "ARG_LIMIT";
  }
  return error;
}

export function createProcessAdapter({ spawnImpl = spawn } = {}) {
  return {
    run(
      command,
      {
        timeoutMs = 120_000,
        maxOutputBytes = 64 * 1024,
        killGraceMs = 2_000,
        forcedKillSettlementMs = 1_000,
        maxArgBytes = SAFE_ARG_BYTES,
      } = {},
    ) {
      return new Promise((resolve, reject) => {
        const executable = command.executable;
        const args = command.args ?? [];
        const prompt = promptFromArgs(args);

        // Refuse to launch an oversized command deterministically rather than
        // relying on the kernel to reject the exec with E2BIG.
        const { largest } = measureArgv(executable, args);
        if (largest > maxArgBytes) {
          const error = new Error("reviewer command exceeds safe argument size");
          error.code = "ARG_LIMIT";
          reject(error);
          return;
        }

        const { readOnly: _readOnly, ...spawnOptions } = command.options ?? {};
        // The scrubbed reviewer environment is frozen so it cannot be widened
        // after construction, but Node injects NODE_V8_COVERAGE into a child's
        // env object at spawn time when the parent runs under coverage, which
        // throws on a frozen object and fails every review. Hand spawn a
        // mutable shallow copy: the allowlist still decides what is in it, and
        // the only thing the runtime may add is the coverage profile path,
        // which cannot load code the way NODE_OPTIONS could.
        if (spawnOptions.env) spawnOptions.env = { ...spawnOptions.env };
        const useProcessGroupKill = SUPPORTS_PROCESS_GROUP_KILL;
        let child;
        let supervision;
        try {
          child = spawnImpl(executable, args, {
            ...spawnOptions,
            detached: useProcessGroupKill,
            stdio: ["ignore", "pipe", "pipe"],
          });
          supervision = superviseChildProcess(child, { detached: useProcessGroupKill });
        } catch (error) {
          reject(sanitizeProcessError(normalizeArgError(error), prompt));
          return;
        }

        const stdout = [];
        const stderr = [];
        let size = 0;
        let settled = false;
        let pendingError = null;
        let timeoutTimer;
        let terminationTimer;
        let settlementTimer;

        const clearTimers = () => {
          clearTimeout(timeoutTimer);
          clearTimeout(terminationTimer);
          clearTimeout(settlementTimer);
        };
        // Settles the returned promise exactly once; termination timers below
        // keep running independently so a signal-ignoring child is still reaped.
        const settle = (callback) => {
          if (settled) return;
          settled = true;
          clearTimers();
          supervision?.unregister();
          callback();
        };
        const kill = (signal) => {
          supervision.signal(signal);
        };
        // Bounded SIGTERM -> SIGKILL escalation. Records the failure but only
        // settles once the child is actually reaped (or the settlement backstop
        // fires), so we never resolve while leaving a runaway reviewer behind.
        const terminate = (error) => {
          if (pendingError) return;
          pendingError = error;
          kill("SIGTERM");
          terminationTimer = setTimeout(() => {
            kill("SIGKILL");
            settlementTimer = setTimeout(() => settle(() => reject(error)), forcedKillSettlementMs);
            settlementTimer.unref?.();
          }, killGraceMs);
          terminationTimer.unref?.();
        };

        const collect = (target) => (chunk) => {
          size += chunk.length;
          if (size > maxOutputBytes) {
            const error = new Error("reviewer output exceeds size limit");
            error.code = "OUTPUT_LIMIT";
            terminate(error);
            return;
          }
          target.push(chunk);
        };

        child.stdout.on("data", collect(stdout));
        child.stderr.on("data", collect(stderr));
        child.on("error", (error) => {
          settle(() => reject(sanitizeProcessError(pendingError ?? normalizeArgError(error), prompt)));
        });
        child.on("close", (code, signal) => {
          settle(() => {
            if (pendingError) {
              reject(pendingError);
              return;
            }
            resolve(sanitizeProcessResult({
              code,
              signal,
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
            }, prompt));
          });
        });

        timeoutTimer = setTimeout(() => {
          const error = new Error("reviewer timed out");
          error.code = "TIMEOUT";
          terminate(error);
        }, timeoutMs);
        timeoutTimer.unref?.();
      });
    },
  };
}

// Streaming, byte-capped git runner for review diff collection. It stops reading
// and terminates git as soon as the cap is exceeded, so an adversarially large
// diff can never be fully buffered into memory before the size check runs.
export function createGitDiffRunner({
  spawnImpl = spawn,
  gitBinary = "git",
  killGraceMs = 2_000,
  forcedKillSettlementMs = 1_000,
  defaultMaxBytes = 1024 * 1024,
} = {}) {
  return ({ repoRoot, args, maxBytes = defaultMaxBytes, timeoutMs = 30_000 } = {}) =>
    new Promise((resolve, reject) => {
      let child;
      let supervision;
      const useProcessGroupKill = SUPPORTS_PROCESS_GROUP_KILL;
      try {
        child = spawnImpl(gitBinary, ["-C", repoRoot, ...args], {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          detached: useProcessGroupKill,
        });
        supervision = superviseChildProcess(child, { detached: useProcessGroupKill });
      } catch (error) {
        reject(error);
        return;
      }

      const stdout = [];
      const stderr = [];
      let kept = 0;
      let stderrBytes = 0;
      let totalBytes = 0;
      // Tracked independently: a timed-out diff must fail even if the child
      // later exits 0 (e.g. it caught SIGTERM), regardless of whether the
      // output cap was ever hit, and regardless of whether SIGKILL was needed.
      let oversize = false;
      let timedOut = false;
      let terminated = false;
      let settled = false;
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
        oversize,
        timedOut,
        terminated,
        bytes: totalBytes,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
      const timeoutError = (code = null, signal = null) => {
        const error = new Error("git diff timed out");
        error.code = "TIMEOUT";
        error.result = result(code, signal);
        return error;
      };
      const settle = (callback) => {
        if (settled) return;
        settled = true;
        clearTimers();
        supervision?.unregister();
        callback();
      };
      const kill = (signal) => {
        supervision.signal(signal);
      };
      // Bounded SIGTERM -> SIGKILL escalation shared by the oversize and
      // timeout paths. The outcome once the child is reaped (or the forced
      // settlement backstop fires) is decided independently by `timedOut`
      // below, not by which caller triggered termination first.
      const terminate = () => {
        if (terminated) return;
        terminated = true;
        kill("SIGTERM");
        terminationTimer = setTimeout(() => {
          kill("SIGKILL");
          settlementTimer = setTimeout(
            () => settle(() => (timedOut ? reject(timeoutError(null, "SIGKILL")) : resolve(result(null, "SIGKILL")))),
            forcedKillSettlementMs,
          );
          settlementTimer.unref?.();
        }, killGraceMs);
        terminationTimer.unref?.();
      };

      child.stdout.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (oversize) return;
        const room = Number.isFinite(maxBytes) ? maxBytes - kept : Infinity;
        if (chunk.length <= room) {
          stdout.push(chunk);
          kept += chunk.length;
          return;
        }
        if (room > 0) {
          stdout.push(chunk.subarray(0, room));
          kept += room;
        }
        oversize = true;
        terminate();
      });
      child.stderr.on("data", (chunk) => {
        if (stderrBytes >= 8 * 1024) return;
        stderrBytes += chunk.length;
        stderr.push(chunk);
      });
      // A timed-out diff must remain a failure even if the child ignores the
      // signal race and reports a clean close (e.g. it handled SIGTERM itself
      // and exited 0): `timedOut` overrides an otherwise-successful outcome.
      child.on("error", (error) => settle(() => reject(timedOut ? timeoutError() : error)));
      child.on("close", (code, signal) => {
        settle(() => {
          if (timedOut) {
            reject(timeoutError(code, signal));
            return;
          }
          resolve(result(code, signal));
        });
      });

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeoutTimer.unref?.();
    });
}
