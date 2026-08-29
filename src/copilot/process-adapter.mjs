import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { superviseChildProcess } from "../process/live-child-supervisor.mjs";

// Default per-stream byte cap for a Copilot invocation. Generous enough for a
// real agent transcript, but bounded so a runaway or adversarial process can
// never grow the buffered output (and this process's memory) without limit.
export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const SUPPORTS_PROCESS_GROUP_KILL = process.platform !== "win32";

function redactPrompt(value, prompt) {
  if (typeof value !== "string" || typeof prompt !== "string" || prompt === "") return value;
  return value.split(prompt).join("[REDACTED]");
}

// Recurses through the full `cause` chain unconditionally - not only when the
// current node's own message/args/spawnargs match - so a prompt buried several
// causes deep is still found and redacted even though the outer error's own
// fields are clean. A string cause is redacted directly instead of being
// returned untouched, and `seen` drops a circular cause node rather than
// looping forever (never expected in practice, but cheap to guard).
function redactError(error, prompt, seen = new WeakSet()) {
  if (typeof error === "string") return redactPrompt(error, prompt);
  if (!error || typeof error !== "object" || !prompt) return error;
  if (seen.has(error)) return undefined;
  seen.add(error);
  const containsPrompt = (value) => Array.isArray(value)
    && value.some((entry) => typeof entry === "string" && entry.includes(prompt));
  const sanitizedCause = error.cause !== undefined ? redactError(error.cause, prompt, seen) : undefined;
  // Primitive causes (string/number/...) compare by value, so this is only
  // true when redaction actually changed something further down the chain.
  const causeChanged = error.cause !== undefined && sanitizedCause !== error.cause;
  const needsRedaction = Boolean(
    `${error.message ?? ""}`.includes(prompt)
    || containsPrompt(error.args)
    || containsPrompt(error.spawnargs)
    || causeChanged,
  );
  if (!needsRedaction) {
    return error;
  }
  const sanitized = new Error(redactPrompt(error.message, prompt));
  sanitized.name = error.name;
  if (error.code !== undefined) sanitized.code = error.code;
  if (error.signal !== undefined) sanitized.signal = error.signal;
  if (error.cause !== undefined) sanitized.cause = sanitizedCause;
  if (Array.isArray(error.args)) sanitized.args = error.args.map((arg) => redactPrompt(arg, prompt));
  if (Array.isArray(error.spawnargs)) {
    sanitized.spawnargs = error.spawnargs.map((arg) => redactPrompt(arg, prompt));
  }
  return sanitized;
}

function redactResult(result, prompt) {
  const redactArgs = (args) => Array.isArray(args)
    ? args.map((arg) => redactPrompt(arg, prompt))
    : args;
  return {
    ...result,
    error: redactError(result.error, prompt),
    stdout: redactPrompt(result.stdout, prompt),
    stderr: redactPrompt(result.stderr, prompt),
    command: redactPrompt(result.command, prompt),
    args: redactArgs(result.args),
    spawnargs: redactArgs(result.spawnargs),
  };
}

// The prompt is always appended as the final argv pair (`-p <prompt>`; see
// runCopilot below). Masking only that trailing position - instead of
// scanning for any "-p"/"--prompt"-looking value anywhere in argv - means an
// earlier flag value that happens to equal "-p" (e.g. an agent id of "-p")
// can never be mistaken for the real prompt flag, which would otherwise mask
// the wrong element and leave the true prompt exposed in the returned args.
function redactArgs(args) {
  const redacted = [...args];
  const flagIndex = redacted.length - 2;
  if (flagIndex >= 0 && (redacted[flagIndex] === "-p" || redacted[flagIndex] === "--prompt")) {
    redacted[flagIndex + 1] = "[REDACTED]";
  }
  return redacted;
}

function toBuffer(chunk) {
  return typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
}

export function inspectModelLog(logText, expectedModel) {
  if (!expectedModel || typeof logText !== "string") return null;
  const matches = [...logText.matchAll(/["']?(?:model|model_name|modelName)["']?\s*[:=]\s*["']?([A-Za-z0-9._-]+)/gi)];
  if (matches.length === 0) {
    return {
      code: "model-log-unconfirmed",
      severity: "diagnostic",
      message: `Model log did not identify the requested model "${expectedModel}"`,
    };
  }
  const observedModel = matches.at(-1)[1];
  if (observedModel === expectedModel) return null;
  return {
    code: "model-log-mismatch",
    severity: "diagnostic",
    expectedModel,
    observedModel,
    message: `Model log reported "${observedModel}" after "${expectedModel}" was requested`,
  };
}

export function spawnProcess(binary, args, options = {}) {
  const {
    spawnImpl = spawn,
    timeoutMs = 0,
    killSignal = "SIGTERM",
    killGraceMs = 1_000,
    forcedKillSettlementMs = 1_000,
    maxStdoutBytes = DEFAULT_MAX_OUTPUT_BYTES,
    maxStderrBytes = DEFAULT_MAX_OUTPUT_BYTES,
    signal: abortSignal,
    ...spawnOptions
  } = options;
  if (!Number.isFinite(killGraceMs) || killGraceMs < 0) {
    throw new RangeError("killGraceMs must be a non-negative finite number");
  }
  if (!Number.isFinite(forcedKillSettlementMs) || forcedKillSettlementMs < 0) {
    throw new RangeError("forcedKillSettlementMs must be a non-negative finite number");
  }
  if (!(Number.isFinite(maxStdoutBytes) && maxStdoutBytes > 0)) {
    throw new RangeError("maxStdoutBytes must be a positive finite number");
  }
  if (!(Number.isFinite(maxStderrBytes) && maxStderrBytes > 0)) {
    throw new RangeError("maxStderrBytes must be a positive finite number");
  }

  return new Promise((resolve) => {
    let child;
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    let aborted = false;
    let outputExceeded = null;
    let spawnError = null;
    let settled = false;
    let terminating = false;
    let timer;
    let terminationTimer;
    let settlementTimer;
    let supervision;

    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (settlementTimer) clearTimeout(settlementTimer);
    };

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      abortSignal?.removeEventListener("abort", onAbort);
      supervision?.unregister();
      resolve({
        exitCode,
        signal,
        error: spawnError,
        timedOut,
        aborted,
        outputExceeded,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    };

    const useProcessGroupKill = SUPPORTS_PROCESS_GROUP_KILL;
    try {
      child = spawnImpl(binary, args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: useProcessGroupKill,
      });
      supervision = superviseChildProcess(child, { detached: useProcessGroupKill });
    } catch (error) {
      spawnError = error;
      finish(null, null);
      return;
    }

    // Signals the whole POSIX process group so a Copilot invocation that
    // forks helper processes cannot outlive termination; falls back to
    // signaling only the direct child when group signaling is unavailable
    // (Windows, or a pid that no longer identifies a live group). The direct
    // fallback only fires when the group signal was not attempted or did not
    // go through: the child is itself a member of its own process group, so a
    // successful group signal already reaches it, and also signaling it
    // directly would deliver the same signal twice (e.g. double-invoking a
    // SIGTERM handler).
    const kill = (signal) => {
      supervision.signal(signal);
    };

    // Bounded SIGTERM -> SIGKILL escalation, shared by the timeout path and
    // the output-cap path below. Settlement timers keep running independently
    // of the escalation so a signal-ignoring process is still reaped.
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      kill(killSignal);
      terminationTimer = setTimeout(() => {
        kill("SIGKILL");
        settlementTimer = setTimeout(
          () => finish(null, "SIGKILL"),
          forcedKillSettlementMs,
        );
        settlementTimer.unref?.();
      }, killGraceMs);
      terminationTimer.unref?.();
    };

    // An external AbortSignal tears the process tree down through the same
    // bounded SIGTERM -> SIGKILL escalation as a timeout, so an interrupted
    // run cannot leave orphaned descendants behind.
    function onAbort() {
      aborted = true;
      terminate();
    }

    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    // Bounded, memory-safe collectors: once a stream's running total would
    // exceed its cap the triggering chunk is dropped (never buffered) and the
    // whole process tree is terminated instead of letting output grow further.
    const capturer = (chunks, streamName, cap) => {
      let bytes = 0;
      return (rawChunk) => {
        const chunk = toBuffer(rawChunk);
        bytes += chunk.length;
        if (bytes > cap) {
          if (!outputExceeded) {
            outputExceeded = streamName;
            spawnError = spawnError ?? Object.assign(
              new Error(`copilot ${streamName} exceeded the configured ${cap}-byte cap`),
              { code: "OUTPUT_LIMIT" },
            );
          }
          terminate();
          return;
        }
        chunks.push(chunk);
      };
    };

    child.stdout?.on("data", capturer(stdoutChunks, "stdout", maxStdoutBytes));
    child.stderr?.on("data", capturer(stderrChunks, "stderr", maxStderrBytes));
    child.once("error", (error) => {
      // Preserve an output-limit error already recorded above rather than
      // letting an incidental error event (e.g. from signaling a dying
      // process) overwrite the real reason for termination.
      spawnError = spawnError ?? error;
      finish(null, null);
    });
    child.once("close", (exitCode, signal) => finish(exitCode, signal));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

function buildResult(processResult, metadata, diagnostics) {
  const status = processResult.aborted
    ? "aborted"
    : processResult.timedOut
      ? "timeout"
      : processResult.outputExceeded
        ? "output-limit"
        : processResult.error
          ? "error"
          : processResult.signal
            ? "signaled"
            : processResult.exitCode === 0
              ? "succeeded"
              : "failed";
  return {
    status,
    ok: status === "succeeded",
    ...processResult,
    ...metadata,
    diagnostics,
  };
}

export async function runCopilot({
  prompt,
  agent,
  model,
  cwd,
  binary = "copilot",
  args = [],
  timeoutMs = 0,
  killGraceMs = 1_000,
  forcedKillSettlementMs = 1_000,
  maxStdoutBytes = DEFAULT_MAX_OUTPUT_BYTES,
  maxStderrBytes = DEFAULT_MAX_OUTPUT_BYTES,
  env = process.env,
  runner,
  spawnImpl,
  modelLogPath,
  readFileImpl = readFile,
  signal,
} = {}) {
  if (typeof prompt !== "string" || prompt.trim() === "") throw new TypeError("prompt must be non-empty text");
  if (typeof agent !== "string" || agent.trim() === "") throw new TypeError("agent must be an explicit agent ID");
  if (typeof cwd !== "string" || cwd.trim() === "") throw new TypeError("cwd must be an explicit path");
  if (typeof binary !== "string" || binary.trim() === "") throw new TypeError("binary must be non-empty");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new TypeError("args must be strings");

  const commandArgs = ["--agent", agent];
  if (model) commandArgs.push("--model", model);
  commandArgs.push(...args, "-p", prompt);

  const execute = runner ?? ((spec) => spawnProcess(spec.binary, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    timeoutMs: spec.timeoutMs,
    killGraceMs: spec.killGraceMs,
    forcedKillSettlementMs: spec.forcedKillSettlementMs,
    maxStdoutBytes: spec.maxStdoutBytes,
    maxStderrBytes: spec.maxStderrBytes,
    spawnImpl,
    signal: spec.signal,
  }));
  const startedAt = new Date().toISOString();
  let processResult;
  try {
    processResult = await execute({
      binary,
      args: commandArgs,
      cwd,
      env,
      timeoutMs,
      killGraceMs,
      forcedKillSettlementMs,
      maxStdoutBytes,
      maxStderrBytes,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    processResult = {
      exitCode: null,
      signal: null,
      error,
      timedOut: false,
      aborted: false,
      outputExceeded: null,
      stdout: "",
      stderr: "",
    };
  }
  const diagnostics = [];
  if (modelLogPath) {
    try {
      const diagnostic = inspectModelLog(await readFileImpl(modelLogPath, "utf8"), model);
      if (diagnostic) diagnostics.push(diagnostic);
    } catch (error) {
      diagnostics.push({
        code: "model-log-unreadable",
        severity: "diagnostic",
        message: error.message,
      });
    }
  }

  const safeProcessResult = redactResult(processResult, prompt);
  return buildResult(safeProcessResult, {
    command: binary,
    args: redactArgs(commandArgs),
    startedAt,
    finishedAt: new Date().toISOString(),
  }, diagnostics);
}
