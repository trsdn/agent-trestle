import path from "node:path";

/**
 * Container sandbox command construction.
 *
 * This module never spawns anything. It rewrites an already-built
 * `{ binary, args }` invocation into a container-runtime argv, so the existing
 * process adapter keeps ownership of spawning, supervision, output caps and
 * prompt redaction. Containment therefore becomes a property of the kernel's
 * mount and network namespaces rather than of a path string that the agent
 * process is merely asked to respect.
 */

export class SandboxConfigError extends Error {
  constructor(message, code = "SANDBOX_CONFIG") {
    super(message);
    this.name = "SandboxConfigError";
    this.code = code;
  }
}

const SUPPORTED_RUNTIMES = Object.freeze(["docker", "podman"]);
// "host" is deliberately absent: it would hand the container the host network
// stack and undo the isolation this module exists to provide.
const SUPPORTED_NETWORKS = Object.freeze(["none", "bridge"]);
const SANDBOX_KEYS = Object.freeze([
  "runtime", "image", "network", "pidsLimit", "memory", "cpus", "env", "copilotHome",
]);

const DEFAULT_PIDS_LIMIT = 512;
export const WORKDIR = "/work";
export const COPILOT_HOME_MOUNT = "/copilot-home";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESOURCE_VALUE = /^[0-9]+(\.[0-9]+)?[a-zA-Z]*$/;

/**
 * Rejects a value a container runtime would parse as an option rather than as
 * the operand it is meant to be. Every value here reaches an argv position, so
 * a leading dash is the difference between "an image called -v" and an
 * attacker-chosen mount.
 */
function assertOperand(value, context) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SandboxConfigError(`${context} must be a non-empty string`);
  }
  if (value.startsWith("-")) {
    throw new SandboxConfigError(`${context} must not start with "-": ${value}`);
  }
  // A newline or NUL cannot survive argv intact and usually means the value was
  // assembled from untrusted input.
  if (/[\0\r\n]/.test(value)) {
    throw new SandboxConfigError(`${context} must not contain control characters`);
  }
  return value;
}

/**
 * Normalises a host path for use as the source half of a `--volume` spec.
 *
 * The runtime splits a volume spec on ":", so an unchecked path is an injection
 * point: a trailing `:/etc` would mount somewhere the caller never named, and a
 * trailing `:ro` would rewrite the options. Windows drive letters make exactly
 * one colon legitimate, so the platforms are checked separately rather than by
 * a shared "no colons" rule that would reject every Windows path.
 */
export function normalizeMountSource(candidate, { platform = process.platform } = {}) {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new SandboxConfigError("mount source must be a non-empty path");
  }
  if (/[\0\r\n]/.test(candidate)) {
    throw new SandboxConfigError("mount source must not contain control characters");
  }
  const impl = platform === "win32" ? path.win32 : path.posix;
  const resolved = impl.normalize(candidate);
  if (!impl.isAbsolute(resolved)) {
    throw new SandboxConfigError(`mount source must be an absolute path: ${candidate}`);
  }
  if (platform === "win32") {
    const match = /^([A-Za-z]:)([\\/].*)$/.exec(resolved);
    if (!match) {
      throw new SandboxConfigError(`mount source must be a drive-qualified path: ${candidate}`);
    }
    if (match[2].includes(":")) {
      throw new SandboxConfigError(`mount source must not contain ":": ${candidate}`);
    }
    return resolved;
  }
  if (resolved.includes(":")) {
    throw new SandboxConfigError(`mount source must not contain ":": ${candidate}`);
  }
  return resolved;
}

function normalizeResource(value, context) {
  if (value === undefined) return undefined;
  assertOperand(value, context);
  if (!RESOURCE_VALUE.test(value)) {
    throw new SandboxConfigError(`${context} must look like "2g" or "1.5": ${value}`);
  }
  return value;
}

function normalizeEnvNames(value, context) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new SandboxConfigError(`${context} must be an array`);
  const names = [];
  for (const name of value) {
    if (typeof name !== "string" || !ENV_NAME.test(name)) {
      throw new SandboxConfigError(`${context} entries must be environment names: ${name}`);
    }
    if (!names.includes(name)) names.push(name);
  }
  return Object.freeze(names);
}

/**
 * Validates and defaults a sandbox declaration. Unknown keys are rejected for
 * the same reason the config schema is closed: an unrecognised option here
 * would silently fail to constrain anything.
 */
export function normalizeSandbox(value, context = "sandbox", { platform = process.platform } = {}) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new SandboxConfigError(`${context} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !SANDBOX_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new SandboxConfigError(`${context} contains unknown keys: ${unknown.sort().join(", ")}`);
  }

  const runtime = value.runtime ?? "docker";
  if (!SUPPORTED_RUNTIMES.includes(runtime)) {
    throw new SandboxConfigError(
      `${context}.runtime must be one of ${SUPPORTED_RUNTIMES.join(", ")}: ${runtime}`,
    );
  }
  const image = assertOperand(value.image, `${context}.image`);
  const network = value.network ?? "none";
  if (!SUPPORTED_NETWORKS.includes(network)) {
    throw new SandboxConfigError(
      `${context}.network must be one of ${SUPPORTED_NETWORKS.join(", ")}: ${network}`,
    );
  }
  const pidsLimit = value.pidsLimit ?? DEFAULT_PIDS_LIMIT;
  if (!Number.isSafeInteger(pidsLimit) || pidsLimit <= 0) {
    throw new SandboxConfigError(`${context}.pidsLimit must be a positive integer`);
  }

  return Object.freeze({
    runtime,
    image,
    network,
    pidsLimit,
    memory: normalizeResource(value.memory, `${context}.memory`),
    cpus: normalizeResource(value.cpus, `${context}.cpus`),
    env: normalizeEnvNames(value.env, `${context}.env`),
    copilotHome: value.copilotHome === undefined
      ? undefined
      : normalizeMountSource(value.copilotHome, { platform }),
  });
}

/**
 * Metadata safe to place in an audit record: what the sandbox grants, with no
 * environment values and no prompt.
 */
export function describeSandbox(sandbox) {
  return Object.freeze({
    runtime: sandbox.runtime,
    image: sandbox.image,
    network: sandbox.network,
    pidsLimit: sandbox.pidsLimit,
    memory: sandbox.memory,
    cpus: sandbox.cpus,
    env: [...sandbox.env],
    copilotHomeMounted: sandbox.copilotHome !== undefined,
  });
}

/**
 * Rewrites `{ binary, args }` into a container-runtime invocation.
 *
 * The original command is appended last and unchanged, which keeps the trailing
 * `-p <prompt>` argv pair in final position. Positional prompt redaction in the
 * process adapter therefore keeps working on the rewritten argv rather than
 * silently masking the wrong element.
 */
export function buildContainerCommand({
  binary,
  args = [],
  cwd,
  sandbox,
  platform = process.platform,
  getuid = typeof process.getuid === "function" ? process.getuid.bind(process) : undefined,
  getgid = typeof process.getgid === "function" ? process.getgid.bind(process) : undefined,
} = {}) {
  assertOperand(binary, "sandbox command binary");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new SandboxConfigError("sandbox command args must be strings");
  }
  if (sandbox === undefined || sandbox === null) {
    throw new SandboxConfigError("sandbox configuration is required");
  }
  const source = normalizeMountSource(cwd, { platform });

  const argv = [
    "run",
    "--rm",
    "--network", sandbox.network,
    "--workdir", WORKDIR,
    "--volume", `${source}:${WORKDIR}`,
    // An agent has no use for Linux capabilities, and no-new-privileges stops a
    // setuid binary inside the image from regaining any.
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(sandbox.pidsLimit),
  ];

  // Without this the container writes into the bind-mounted worktree as root
  // and leaves host files the invoking user cannot clean up. Windows has no uid
  // to map, and Docker Desktop already translates ownership there.
  if (platform !== "win32" && getuid && getgid) {
    argv.push("--user", `${getuid()}:${getgid()}`);
  }
  if (sandbox.memory) argv.push("--memory", sandbox.memory);
  if (sandbox.cpus) argv.push("--cpus", sandbox.cpus);
  if (sandbox.copilotHome !== undefined) {
    argv.push("--volume", `${sandbox.copilotHome}:${COPILOT_HOME_MOUNT}:ro`);
    argv.push("--env", `COPILOT_HOME=${COPILOT_HOME_MOUNT}`);
  }
  // Passing the bare name makes the runtime read the value from this process's
  // environment, so a secret never reaches argv where it would show up in a
  // process listing or an audit record.
  for (const name of sandbox.env) argv.push("--env", name);

  argv.push(sandbox.image, binary, ...args);
  return Object.freeze({ binary: sandbox.runtime, args: argv });
}
