import { constants as osConstants } from "node:os";

const TERMINATION_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_FORCED_KILL_SETTLEMENT_MS = 50;

function validateDelay(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number`);
  }
}

function signalExitCode(signal) {
  const number = osConstants.signals?.[signal];
  return Number.isInteger(number) ? 128 + number : 1;
}

function defaultReRaise(processImpl, signal) {
  try {
    processImpl.kill(processImpl.pid, signal);
  } catch {
    if (typeof processImpl.exit === "function") {
      processImpl.exit(signalExitCode(signal));
    } else {
      processImpl.exitCode = signalExitCode(signal);
    }
  }
}

export function createLiveChildSupervisor({
  processImpl = process,
  supportsProcessGroupKill = process.platform !== "win32",
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  forcedKillSettlementMs = DEFAULT_FORCED_KILL_SETTLEMENT_MS,
  reRaise = (signal) => defaultReRaise(processImpl, signal),
} = {}) {
  validateDelay(terminationGraceMs, "terminationGraceMs");
  validateDelay(forcedKillSettlementMs, "forcedKillSettlementMs");
  if (typeof reRaise !== "function") throw new TypeError("reRaise must be a function");

  const registrations = new Set();
  const handlers = new Map();
  let handlersInstalled = false;
  let shutdown;
  let escalationTimer;
  let settlementTimer;

  const signalTarget = (registration, signal) => {
    const pid = registration.pid;
    if (
      registration.detached
      && supportsProcessGroupKill
      && Number.isInteger(pid)
      && pid > 1
      && pid !== processImpl.pid
    ) {
      try {
        processImpl.kill(-pid, signal);
        return true;
      } catch {
        // Fall through to direct-child signaling when the group is unavailable.
      }
    }
    try {
      registration.child.kill(signal);
      return true;
    } catch {
      return false;
    }
  };

  const uninstallHandlers = () => {
    if (!handlersInstalled) return;
    for (const [signal, handler] of handlers) {
      processImpl.removeListener(signal, handler);
    }
    handlersInstalled = false;
  };

  const finishShutdown = () => {
    if (!shutdown) return;
    clearTimeout(escalationTimer);
    clearTimeout(settlementTimer);
    const completed = shutdown;
    shutdown = undefined;
    uninstallHandlers();

    if (completed.hasExternalListener) {
      if (registrations.size > 0) installHandlers();
      return;
    }
    reRaise(completed.signal);
  };

  const escalateShutdown = () => {
    if (!shutdown || shutdown.escalated) return;
    shutdown.escalated = true;
    for (const registration of shutdown.targets) {
      signalTarget(registration, "SIGKILL");
    }
    settlementTimer = setTimeout(finishShutdown, forcedKillSettlementMs);
  };

  const handleSignal = (signal) => {
    if (shutdown) {
      escalateShutdown();
      return;
    }

    const ownHandler = handlers.get(signal);
    const hasExternalListener = typeof processImpl.listeners === "function"
      && processImpl.listeners(signal).some((listener) => listener !== ownHandler);
    shutdown = {
      signal,
      hasExternalListener,
      escalated: false,
      targets: new Set(registrations),
    };
    for (const registration of shutdown.targets) {
      signalTarget(registration, "SIGTERM");
    }
    escalationTimer = setTimeout(escalateShutdown, terminationGraceMs);
  };

  function installHandlers() {
    if (handlersInstalled || shutdown || registrations.size === 0) return;
    for (const signal of TERMINATION_SIGNALS) {
      let handler = handlers.get(signal);
      if (!handler) {
        handler = () => handleSignal(signal);
        handlers.set(signal, handler);
      }
      processImpl.on(signal, handler);
    }
    handlersInstalled = true;
  }

  const register = (child, { detached = false } = {}) => {
    if (
      child === null
      || typeof child !== "object"
      || typeof child.once !== "function"
      || typeof child.removeListener !== "function"
      || typeof child.kill !== "function"
    ) {
      throw new TypeError("child must be a ChildProcess-like event emitter");
    }

    const registration = {
      child,
      detached: detached === true,
      pid: child.pid,
      active: true,
    };
    registrations.add(registration);

    const unregister = () => {
      if (!registration.active) return;
      registration.active = false;
      registrations.delete(registration);
      child.removeListener("close", unregister);
      child.removeListener("error", unregister);
      if (registrations.size === 0 && !shutdown) uninstallHandlers();
    };
    child.once("close", unregister);
    child.once("error", unregister);

    if (shutdown) {
      shutdown.targets.add(registration);
      signalTarget(registration, "SIGTERM");
      if (shutdown.escalated) signalTarget(registration, "SIGKILL");
    } else {
      installHandlers();
    }

    return Object.freeze({
      unregister,
      signal: (signal) => signalTarget(registration, signal),
    });
  };

  return Object.freeze({
    register,
    activeCount: () => registrations.size,
  });
}

export const liveChildSupervisor = createLiveChildSupervisor();

export function superviseChildProcess(child, options) {
  return liveChildSupervisor.register(child, options);
}
