import { constants } from "node:fs";
import { access, link, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentDefinition } from "../config/agent-definition.mjs";
import { loadConfig, validateId } from "../config/config.mjs";
import { resolveSkillPaths, selectSkills } from "../config/skills.mjs";
import { spawnProcess } from "../copilot/process-adapter.mjs";
import { createJsonFileDataProvider } from "../dashboard/provider.mjs";
import { createDashboardServer } from "../dashboard/server.mjs";
import { dispatch } from "../dispatch/dispatch.mjs";
import {
  resolveConfigDirectory,
  resolveProjectDirectory,
  resolveRoute,
  resolveWorkstreamDirectory,
} from "../dispatch/router.mjs";
import { createReviewGitAdapter } from "../review/git-adapter.mjs";
import { runReviewGate } from "../review/gate.mjs";
import { createGitDiffRunner, createProcessAdapter } from "../review/process-adapter.mjs";
import { PathSecurityError, pinDirectory, releasePin, verifyDescendant } from "../security/path-security.mjs";
import { runTrestleMcpStdio } from "../state/mcp-server.mjs";
import { createTrestleStateStore, TrestleStateError } from "../state/store.mjs";
import { createWorktreeFleet } from "../worktrees/fleet.mjs";
import { createGitProcessAdapter } from "../worktrees/git-adapter.mjs";

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  FAILED: 1,
  USAGE: 2,
  NOT_SUPPORTED: 3,
  ENVIRONMENT: 4,
  BLOCKED: 5,
});

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMMANDS = new Set([
  "init", "validate", "doctor", "resolve", "dispatch", "run", "review",
  "fleet", "dashboard", "state-server", "state-lock", "state-unlock",
]);

const BOOL = Object.freeze({ type: "boolean" });
const VALUE = Object.freeze({ type: "value" });
const VALUE_REPEATABLE = Object.freeze({ type: "value", repeatable: true });

/** Global flags accepted before a command is known (help/version paths). */
const GLOBAL_OPTION_SPEC = Object.freeze({
  help: BOOL,
  version: BOOL,
  json: BOOL,
  root: VALUE,
});

/**
 * Per-command option allowlists. Unknown options are rejected before any
 * command side effects. Value options require a non-empty value and must not
 * treat the next `--flag` as their value.
 */
const COMMAND_OPTION_SPECS = Object.freeze({
  init: Object.freeze({
    help: BOOL, version: BOOL, json: BOOL, root: VALUE, force: BOOL,
  }),
  validate: Object.freeze({
    help: BOOL, version: BOOL, json: BOOL, root: VALUE,
  }),
  doctor: Object.freeze({
    help: BOOL, version: BOOL, json: BOOL, root: VALUE, binary: VALUE,
  }),
  resolve: Object.freeze({
    help: BOOL, version: BOOL, json: BOOL, root: VALUE,
    project: VALUE, workstream: VALUE, role: VALUE,
  }),
  dispatch: Object.freeze({
    help: BOOL, version: BOOL, json: BOOL, root: VALUE,
    project: VALUE, workstream: VALUE, role: VALUE,
    prompt: VALUE, prompt_file: VALUE, skill: VALUE_REPEATABLE, binary: VALUE,
  }),
  run: Object.freeze({
    help: BOOL, version: BOOL, json: BOOL, root: VALUE,
  }),
  review: Object.freeze({
    help: BOOL, version: BOOL, json: BOOL, root: VALUE,
    base: VALUE, head: VALUE, producer: VALUE, reviewer: VALUE,
    attempts: VALUE, timeout_ms: VALUE, merge: BOOL,
  }),
  fleet: Object.freeze({
    help: BOOL, version: BOOL, json: BOOL, root: VALUE,
    worktree_root: VALUE, id: VALUE, start_point: VALUE, path: VALUE,
    force: BOOL, outcome: VALUE,
  }),
  dashboard: Object.freeze({
    help: BOOL, version: BOOL, json: BOOL, root: VALUE, data: VALUE, port: VALUE,
  }),
  "state-server": Object.freeze({
    help: BOOL, version: BOOL, json: BOOL, root: VALUE,
    workstream: VALUE, schemas: VALUE,
  }),
  "state-lock": Object.freeze({
    help: BOOL, version: BOOL, json: BOOL, root: VALUE,
    scope: VALUE, workstream: VALUE, namespace: VALUE, key: VALUE,
  }),
  "state-unlock": Object.freeze({
    help: BOOL, version: BOOL, json: BOOL, root: VALUE,
    scope: VALUE, workstream: VALUE, namespace: VALUE, key: VALUE,
    expected_token: VALUE, expected_inode: VALUE, expected_device: VALUE, recovery: BOOL,
  }),
});

class CliError extends Error {
  constructor(message, exitCode = EXIT_CODES.FAILED, code = "FAILED", details) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

function peekCommand(argv) {
  for (const token of argv) {
    if (!token.startsWith("--")) return token;
  }
  return undefined;
}

function resolveOptionSpec(argv) {
  const command = peekCommand(argv);
  if (command === undefined) return GLOBAL_OPTION_SPEC;
  if (!COMMANDS.has(command)) return GLOBAL_OPTION_SPEC;
  return COMMAND_OPTION_SPECS[command];
}

function parseArgs(argv) {
  const optionSpec = resolveOptionSpec(argv);
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equalIndex = token.indexOf("=");
    let rawName, inline;
    if (equalIndex !== -1) {
      rawName = token.slice(2, equalIndex);
      inline = token.slice(equalIndex + 1);
    } else {
      rawName = token.slice(2);
      inline = undefined;
    }
    if (!rawName) throw new CliError("Invalid empty option", EXIT_CODES.USAGE, "USAGE");
    const name = rawName.replaceAll("-", "_");
    const spec = optionSpec[name];
    if (!spec) {
      throw new CliError(`Unknown option --${rawName}`, EXIT_CODES.USAGE, "USAGE");
    }

    let value = inline;
    if (spec.type === "boolean") {
      if (value === undefined) value = true;
      else if (value === "true") value = true;
      else if (value === "false") value = false;
      else {
        throw new CliError(`--${rawName} is a boolean flag and does not take a value`, EXIT_CODES.USAGE, "USAGE");
      }
    } else {
      if (
        value === undefined
        && argv[index + 1] !== undefined
        && !argv[index + 1].startsWith("--")
      ) {
        value = argv[++index];
      }
      if (value === undefined || value === "") {
        throw new CliError(`--${rawName} requires a non-empty value`, EXIT_CODES.USAGE, "USAGE");
      }
    }

    if (options[name] === undefined) {
      options[name] = value;
    } else if (spec.repeatable) {
      options[name] = Array.isArray(options[name]) ? [...options[name], value] : [options[name], value];
    } else if (spec.type === "boolean") {
      options[name] = value;
    } else {
      throw new CliError(`--${rawName} may only be specified once`, EXIT_CODES.USAGE, "USAGE");
    }
  }
  return { positionals, options };
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliError(`--${name.replaceAll("_", "-")} is required`, EXIT_CODES.USAGE, "USAGE");
  }
  return value;
}

function positiveInteger(value, label, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CliError(`${label} must be a non-negative integer`, EXIT_CODES.USAGE, "USAGE");
  }
  return parsed;
}

function strictlyPositiveInteger(value, label, fallback) {
  const parsed = positiveInteger(value, label, fallback);
  if (parsed < 1) {
    throw new CliError(`${label} must be a positive integer`, EXIT_CODES.USAGE, "USAGE");
  }
  return parsed;
}

function rootFrom(options, cwd) {
  return path.resolve(cwd, typeof options.root === "string" ? options.root : ".");
}

function overwriteError(targetName) {
  return new CliError(`Refusing to overwrite ${targetName}; use --force explicitly`, EXIT_CODES.BLOCKED, "EXISTS");
}

async function lstatIfExists(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertSafeInitTarget(rootPin, target, targetName, { force } = {}) {
  await verifyDescendant(rootPin, target, { allowMissing: true });
  const existing = await lstatIfExists(target);
  if (existing?.isSymbolicLink()) {
    throw new PathSecurityError(`Path must not contain symbolic links: ${targetName}`);
  }
  if (existing && !existing.isFile()) {
    throw new CliError(
      `Refusing to overwrite ${targetName}; existing path is not a regular file`,
      EXIT_CODES.BLOCKED,
      "EXISTS",
    );
  }
  if (existing && !force) throw overwriteError(targetName);
}

async function writeAtomicInitTarget(rootPin, target, targetName, content, { force } = {}) {
  const directory = path.dirname(target);
  await verifyDescendant(rootPin, directory, { allowMissing: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await verifyDescendant(rootPin, directory, { allowMissing: false });

  const pending = path.resolve(
    directory,
    `.trestle-init-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.pending`,
  );
  await verifyDescendant(rootPin, pending, { allowMissing: true });

  let handle;
  try {
    handle = await open(
      pending,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }

  try {
    if (force) {
      const existing = await lstatIfExists(target);
      if (existing?.isSymbolicLink()) {
        throw new PathSecurityError(`Path must not contain symbolic links: ${targetName}`);
      }
      if (existing && !existing.isFile()) {
        throw new CliError(
          `Refusing to overwrite ${targetName}; existing path is not a regular file`,
          EXIT_CODES.BLOCKED,
          "EXISTS",
        );
      }
      await rename(pending, target);
    } else {
      try {
        await link(pending, target);
      } catch (error) {
        if (error.code === "EEXIST") throw overwriteError(targetName);
        throw error;
      }
      await rm(pending, { force: true });
    }
    await verifyDescendant(rootPin, target, { allowMissing: false });
  } finally {
    await rm(pending, { force: true }).catch(() => {});
  }
}

function publicError(error) {
  return {
    code: error.code ?? "FAILED",
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

function serializable(value) {
  return JSON.parse(JSON.stringify(value, (_key, entry) => {
    if (entry instanceof Error) return publicError(entry);
    if (entry instanceof Map) return Object.fromEntries(entry);
    return entry;
  }));
}

function writeResult(io, value, json) {
  if (json) io.stdout.write(`${JSON.stringify(serializable(value))}\n`);
  else if (typeof value === "string") io.stdout.write(`${value}\n`);
  else io.stdout.write(`${JSON.stringify(serializable(value), null, 2)}\n`);
}

/**
 * Product identity read from the packaged manifest.
 *
 * The manifest is the single hand-maintained source, and the release workflow
 * refuses to publish when it disagrees with the tag, so `--version` and
 * `--help` cannot drift away from the artifact a user installed.
 */
async function packageIdentity() {
  const pkg = JSON.parse(await readFile(path.resolve(PACKAGE_ROOT, "package.json"), "utf8"));
  const repository = String(pkg.repository?.url ?? "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
  return {
    name: pkg.name,
    version: pkg.version,
    repository,
    bugs: pkg.bugs?.url ?? `${repository}/issues`,
    license: pkg.license,
  };
}

function usage(identity) {
  return `Usage: agent-trestle <command> [options]

Commands:
  init          Create a minimal .trestle config and example agent
  validate      Validate config and referenced local resources
  doctor        Validate the project and check the Copilot executable
  resolve       Resolve one explicit project/workstream/role route
  dispatch      Dispatch one prompt through the configured route
  run           Reserved; returns NOT_SUPPORTED in this pre-release
  review        Run a read-only exact-diff review (merge is not supported)
  fleet         Manage isolated Git worktrees: create, remove, prune
  dashboard     Serve a read-only local dashboard from a JSON data file
  state-server  Run the workstream-scoped JSON-RPC/MCP state server
  state-lock    Inspect one per-key state lock, its recovery metadata, and hint
  state-unlock  Explicitly clear one stale per-key state lock. Provide
                --expected-token for a well-formed lock, or --expected-inode
                and --expected-device together to recover a malformed one.
                Add --recovery to explicitly clear a stale recovery barrier.

Global options:
  --root <path> Project root (default: current directory)
  --json        Emit machine-readable output where the command terminates
  --help        Show this help
  --version     Show package version

${identity.name} ${identity.version} (${identity.license})
Project:      ${identity.repository}
Report bugs:  ${identity.bugs}`;
}

async function validateProject(projectRoot) {
  // The pin proves the root resolved safely; only its path is needed from here
  // on, so the descriptor goes back immediately instead of living for the whole
  // validation pass.
  const project = await resolveProjectDirectory(projectRoot);
  await releasePin(project);
  await resolveConfigDirectory(project.path);
  const config = await loadConfig(project.path);
  await resolveConfigDirectory(project.path);
  const agents = new Map();
  const workstreams = [];
  for (const workstream of config.workstreams) {
    const directory = await resolveWorkstreamDirectory(project.path, workstream);
    const roles = [];
    for (const role of workstream.roles) {
      let agent = agents.get(role.agent);
      if (!agent) {
        agent = await loadAgentDefinition(project.path, role.agent);
        agents.set(role.agent, agent);
      }
      const selected = selectSkills({ declared: agent.skills, configured: role.skills ?? [] });
      const skills = await resolveSkillPaths(project.path, selected);
      roles.push({ id: role.id, agent: role.agent, model: agent.model, skills: skills.map(({ id }) => id) });
    }
    workstreams.push({ id: workstream.id, path: workstream.path, roles });
  }
  return {
    ok: true,
    projectRoot: project.path,
    projectId: config.project.id,
    workstreams,
    permissions: config.permissions,
  };
}

async function initCommand(options, cwd) {
  const root = rootFrom(options, cwd);
  const rootPin = await pinDirectory(root, { create: true });
  try {
    const force = options.force === true;
    const targets = [
      ["templates/minimal/.trestle/config.json", ".trestle/config.json"],
      ["templates/minimal/.github/agents/example-builder.agent.md", ".github/agents/example-builder.agent.md"],
    ];
    const planned = [];
    for (const [sourceName, targetName] of targets) {
      const source = path.resolve(PACKAGE_ROOT, sourceName);
      const target = path.resolve(rootPin.path, targetName);
      await assertSafeInitTarget(rootPin, target, targetName, { force });
      planned.push({
        targetName,
        target,
        content: await readFile(source, "utf8"),
      });
    }

    const created = [];
    for (const { targetName, target, content } of planned) {
      await writeAtomicInitTarget(rootPin, target, targetName, content, { force });
      created.push(targetName);
    }
    return { ok: true, command: "init", projectRoot: rootPin.path, created };
  } finally {
    await releasePin(rootPin);
  }
}

async function doctorCommand(options, cwd) {
  const root = rootFrom(options, cwd);
  const checks = [];
  let config;
  try {
    const validation = await validateProject(root);
    config = await loadConfig(root);
    checks.push({ name: "project", ok: true, projectId: validation.projectId });
  } catch (error) {
    checks.push({ name: "project", ok: false, error: publicError(error) });
  }
  const binary = typeof options.binary === "string" ? options.binary : config?.copilot.binary ?? "copilot";
  const result = await spawnProcess(binary, ["--version"], { timeoutMs: 10_000 });
  checks.push({
    name: "copilot",
    ok: result.exitCode === 0 && !result.error && !result.timedOut,
    binary,
    version: result.stdout.trim() || undefined,
    error: result.error ? publicError(result.error) : undefined,
  });
  const ok = checks.every((check) => check.ok);
  return { ok, command: "doctor", projectRoot: root, checks };
}

async function dispatchCommand(options, cwd) {
  const root = rootFrom(options, cwd);
  if ((options.prompt === undefined) === (options.prompt_file === undefined)) {
    throw new CliError("Specify exactly one of --prompt or --prompt-file", EXIT_CODES.USAGE, "USAGE");
  }
  const prompt = options.prompt_file
    ? await readFile(path.resolve(cwd, required(options, "prompt_file")), "utf8")
    : required(options, "prompt");
  const config = await loadConfig(root);
  const result = await dispatch({
    config,
    projectRoot: root,
    projectId: required(options, "project"),
    workstreamId: required(options, "workstream"),
    roleId: required(options, "role"),
    prompt,
    requestedSkills: options.skill === undefined ? [] : Array.isArray(options.skill) ? options.skill : [options.skill],
    binary: typeof options.binary === "string" ? options.binary : undefined,
  });
  return { ok: result.execution.ok, command: "dispatch", ...result };
}

async function reviewCommand(options, cwd) {
  if (options.merge === true) {
    throw new CliError(
      "CLI merge is not yet supported; use the library review gate with an explicit auto-merge policy",
      EXIT_CODES.NOT_SUPPORTED,
      "NOT_SUPPORTED",
    );
  }
  const repoRoot = rootFrom(options, cwd);
  const result = await runReviewGate({
    repoRoot,
    baseRef: required(options, "base"),
    headRef: required(options, "head"),
    producer: required(options, "producer"),
    reviewer: required(options, "reviewer"),
    attempts: strictlyPositiveInteger(options.attempts, "--attempts", 1),
    timeoutMs: strictlyPositiveInteger(options.timeout_ms, "--timeout-ms", 120_000),
    git: createReviewGitAdapter({ runner: createGitDiffRunner() }),
    process: createProcessAdapter(),
    merge: false,
  });
  return { ok: result.status === "passed", command: "review", ...result };
}

async function fleetCommand(positionals, options, cwd) {
  const operation = positionals[1];
  if (!["create", "remove", "prune"].includes(operation)) {
    throw new CliError("fleet requires create, remove, or prune", EXIT_CODES.USAGE, "USAGE");
  }
  const repoRoot = rootFrom(options, cwd);
  const worktreeRoot = path.resolve(cwd, required(options, "worktree_root"));
  const fleet = createWorktreeFleet({
    repoRoot,
    worktreeRoot,
    git: createGitProcessAdapter(),
  });
  if (operation === "create") {
    await mkdir(worktreeRoot, { recursive: true });
    return { ok: true, command: "fleet", operation, worktree: await fleet.create({
      id: required(options, "id"),
      startPoint: typeof options.start_point === "string" ? options.start_point : "HEAD",
    }) };
  }
  if (operation === "remove") {
    const worktree = { id: required(options, "id"), path: path.resolve(cwd, required(options, "path")) };
    return { ok: true, command: "fleet", operation, worktree: await fleet.remove(worktree, {
      force: options.force === true,
      outcome: typeof options.outcome === "string" ? options.outcome : undefined,
    }) };
  }
  await fleet.prune();
  return { ok: true, command: "fleet", operation };
}

async function dashboardCommand(options, cwd, io) {
  const dataFile = path.resolve(cwd, required(options, "data"));
  await access(dataFile);
  const server = createDashboardServer({
    dataProvider: createJsonFileDataProvider(dataFile),
    host: "127.0.0.1",
    port: positiveInteger(options.port, "--port", 0),
  });
  const address = await server.listen();
  const result = {
    ok: true,
    command: "dashboard",
    url: `http://127.0.0.1:${address.port}/`,
    pid: process.pid,
  };
  writeResult(io, result, options.json === true);
  return { persistent: true, result };
}

async function stateServerCommand(options, cwd) {
  const root = rootFrom(options, cwd);
  const workstream = validateId(required(options, "workstream"), "workstream");
  const schemaFile = path.resolve(cwd, required(options, "schemas"));
  const schemas = JSON.parse(await readFile(schemaFile, "utf8"));
  if (!schemas || Array.isArray(schemas) || typeof schemas !== "object") {
    throw new CliError("--schemas must contain a JSON object keyed by namespace", EXIT_CODES.USAGE, "USAGE");
  }
  const store = createTrestleStateStore({
    projectRoot: root,
    projectStateRoot: path.resolve(root, ".trestle/state/project"),
    workstreamStateRoot: path.resolve(root, ".trestle/state/workstreams", workstream),
    configRoot: path.resolve(root, ".trestle/config"),
    workstreamId: workstream,
    schemas,
  });
  await store.health();
  runTrestleMcpStdio({ store });
  return { persistent: true };
}

function stateScopeFrom(options) {
  const scope = typeof options.scope === "string" ? options.scope : "workstream";
  if (!["project", "workstream"].includes(scope)) {
    throw new CliError("--scope must be project or workstream", EXIT_CODES.USAGE, "USAGE");
  }
  return scope;
}

function createStateCliStore(options, cwd) {
  const root = rootFrom(options, cwd);
  const scope = stateScopeFrom(options);
  const workstream = scope === "workstream"
    ? validateId(required(options, "workstream"), "workstream")
    : "__project__";
  return {
    scope,
    store: createTrestleStateStore({
      projectRoot: root,
      projectStateRoot: path.resolve(root, ".trestle/state/project"),
      workstreamStateRoot: path.resolve(root, ".trestle/state/workstreams", workstream),
      configRoot: path.resolve(root, ".trestle/config"),
      workstreamId: scope === "workstream" ? workstream : null,
      schemas: {},
    }),
  };
}

async function stateLockCommand(options, cwd) {
  const { scope, store } = createStateCliStore(options, cwd);
  return {
    ok: true,
    command: "state-lock",
    ...(await store.lockStatus({
      scope,
      namespace: required(options, "namespace"),
      key: required(options, "key"),
    })),
  };
}

async function stateUnlockCommand(options, cwd) {
  const { scope, store } = createStateCliStore(options, cwd);
  const expectedInode = options.expected_inode === undefined
    ? undefined
    : positiveInteger(options.expected_inode, "--expected-inode");
  const expectedDevice = options.expected_device === undefined
    ? undefined
    : positiveInteger(options.expected_device, "--expected-device");
  const hasToken = typeof options.expected_token === "string" && options.expected_token.trim() !== "";
  const recovery = options.recovery === true;
  // A well-formed lock is cleared by its token. A malformed (tokenless) lock is
  // cleared instead by pinning its immutable identity: both inode AND device.
  if (!hasToken && (expectedInode === undefined || expectedDevice === undefined)) {
    throw new CliError(
      "--expected-token is required unless both --expected-inode and --expected-device are provided for tokenless malformed-lock recovery",
      EXIT_CODES.USAGE,
      "USAGE",
    );
  }
  try {
    return {
      ok: true,
      command: "state-unlock",
      ...(await store.unlock({
        scope,
        namespace: required(options, "namespace"),
        key: required(options, "key"),
        ...(hasToken ? { expectedToken: options.expected_token } : {}),
        ...(expectedInode === undefined ? {} : { expectedInode }),
        ...(expectedDevice === undefined ? {} : { expectedDevice }),
        ...(recovery ? { recovery: true } : {}),
      })),
    };
  } catch (error) {
    if (error instanceof TrestleStateError && typeof error.code === "string" && error.code.startsWith("LOCK_")) {
      throw new CliError(error.message, EXIT_CODES.BLOCKED, error.code, error.details);
    }
    throw error;
  }
}

export async function runCli(argv, io = {}) {
  const streams = {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    cwd: io.cwd ?? process.cwd(),
  };
  const { positionals, options } = parseArgs(argv);
  const json = options.json === true;
  if (options.version === true) {
    const identity = await packageIdentity();
    writeResult(streams, json ? identity : identity.version, json);
    return EXIT_CODES.SUCCESS;
  }
  if (options.help === true || positionals.length === 0) {
    writeResult(streams, usage(await packageIdentity()), false);
    return EXIT_CODES.SUCCESS;
  }
  const command = positionals[0];
  if (!COMMANDS.has(command)) {
    throw new CliError(`Unknown command "${command}"`, EXIT_CODES.USAGE, "USAGE");
  }

  let result;
  if (command === "init") result = await initCommand(options, streams.cwd);
  else if (command === "validate") result = { command, ...await validateProject(rootFrom(options, streams.cwd)) };
  else if (command === "doctor") result = await doctorCommand(options, streams.cwd);
  else if (command === "resolve") {
    const config = await loadConfig(rootFrom(options, streams.cwd));
    result = {
      ok: true,
      command,
      route: resolveRoute(config, {
        projectId: required(options, "project"),
        workstreamId: required(options, "workstream"),
        roleId: required(options, "role"),
      }),
    };
  } else if (command === "dispatch") result = await dispatchCommand(options, streams.cwd);
  else if (command === "run") {
    throw new CliError(
      "run is not yet supported because no stable task-manifest contract exists",
      EXIT_CODES.NOT_SUPPORTED,
      "NOT_SUPPORTED",
    );
  } else if (command === "review") result = await reviewCommand(options, streams.cwd);
  else if (command === "fleet") result = await fleetCommand(positionals, options, streams.cwd);
  else if (command === "dashboard") result = await dashboardCommand(options, streams.cwd, streams);
  else if (command === "state-server") result = await stateServerCommand(options, streams.cwd);
  else if (command === "state-lock") result = await stateLockCommand(options, streams.cwd);
  else if (command === "state-unlock") result = await stateUnlockCommand(options, streams.cwd);

  if (result?.persistent) return EXIT_CODES.SUCCESS;
  writeResult(streams, result, json);
  if (result?.ok === false) {
    return command === "review" ? EXIT_CODES.BLOCKED
      : command === "doctor" ? EXIT_CODES.ENVIRONMENT
        : EXIT_CODES.FAILED;
  }
  return EXIT_CODES.SUCCESS;
}

export async function main(argv = process.argv.slice(2), io) {
  try {
    return await runCli(argv, io);
  } catch (error) {
    const normalized = error instanceof CliError
      ? error
      : new CliError(error.message, EXIT_CODES.FAILED, error.code ?? "FAILED", error.details);
    const streams = { stderr: io?.stderr ?? process.stderr };
    const json = argv.includes("--json");
    if (json) streams.stderr.write(`${JSON.stringify({ ok: false, error: publicError(normalized) })}\n`);
    else streams.stderr.write(`agent-trestle: ${normalized.message}\n`);
    return normalized.exitCode;
  }
}
