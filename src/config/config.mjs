import path from "node:path";
import { normalizePermissions } from "./permissions.mjs";
import { normalizeSandbox } from "../sandbox/container.mjs";
import { pinDirectory, readVerifiedFile, releasePin } from "../security/path-security.mjs";

export const CONFIG_DIRECTORY = ".trestle";
export const CONFIG_FILENAME = "config.json";
export const CONFIG_VERSION = 1;

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

function object(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function partialPermissions(value, label) {
  const normalized = normalizePermissions(value, label);
  return Object.fromEntries(Object.keys(value).map((key) => [key, normalized[key]]));
}

export function validateId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be an explicit lowercase ID`);
  }
  return value;
}

function assertNoUnknownKeys(obj, allowed, label) {
  const unknown = Object.keys(obj).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new TypeError(`${label} contains unknown key: ${unknown}`);
  }
}

function validateRole(role, label) {
  object(role, label);
  assertNoUnknownKeys(role, ["id", "agent", "skills", "permissions"], label);
  validateId(role.id, `${label}.id`);
  if (typeof role.agent !== "string" || role.agent.trim() === "") {
    throw new TypeError(`${label}.agent must be a non-empty agent ID`);
  }
  if (role.skills !== undefined && (!Array.isArray(role.skills) || role.skills.some((skill) => typeof skill !== "string"))) {
    throw new TypeError(`${label}.skills must be an array of strings`);
  }
  let permissions;
  if (Object.hasOwn(role, "permissions")) {
    if (role.permissions === null || Array.isArray(role.permissions) || typeof role.permissions !== "object") {
      throw new TypeError(`${label}.permissions must be an object`);
    }
    permissions = partialPermissions(role.permissions, `${label}.permissions`);
  }
  return {
    id: role.id,
    agent: role.agent,
    ...(role.skills ? { skills: [...role.skills] } : {}),
    ...(permissions === undefined ? {} : { permissions }),
  };
}

function validateWorkstream(workstream, index) {
  const label = `workstreams[${index}]`;
  object(workstream, label);
  assertNoUnknownKeys(workstream, ["id", "path", "permissions", "roles"], label);
  validateId(workstream.id, `${label}.id`);
  if (typeof workstream.path !== "string" || workstream.path.trim() === "") {
    throw new TypeError(`${label}.path must be an explicit non-empty path`);
  }
  if (!Array.isArray(workstream.roles) || workstream.roles.length === 0) {
    throw new TypeError(`${label}.roles must be a non-empty array`);
  }
  const roles = workstream.roles.map((role, roleIndex) => validateRole(role, `${label}.roles[${roleIndex}]`));
  assertUnique(roles, `${label}.roles`);
  let permissions;
  if (Object.hasOwn(workstream, "permissions")) {
    if (
      workstream.permissions === null
      || Array.isArray(workstream.permissions)
      || typeof workstream.permissions !== "object"
    ) {
      throw new TypeError(`${label}.permissions must be an object`);
    }
    permissions = partialPermissions(workstream.permissions, `${label}.permissions`);
  }
  return {
    id: workstream.id,
    path: workstream.path,
    roles,
    ...(permissions === undefined ? {} : { permissions }),
  };
}

function assertUnique(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new TypeError(`${label} contains duplicate ID "${item.id}"`);
    seen.add(item.id);
  }
}

export function validateConfig(input) {
  const config = object(input, "config");
  assertNoUnknownKeys(
    config,
    ["version", "project", "permissions", "copilot", "sandbox", "workstreams"],
    "config",
  );
  if (config.version !== CONFIG_VERSION) {
    throw new TypeError(`config.version must be ${CONFIG_VERSION}`);
  }
  object(config.project, "config.project");
  assertNoUnknownKeys(config.project, ["id"], "config.project");
  const projectId = validateId(config.project.id, "config.project.id");
  if (!Array.isArray(config.workstreams) || config.workstreams.length === 0) {
    throw new TypeError("config.workstreams must be a non-empty array");
  }
  const workstreams = config.workstreams.map(validateWorkstream);
  assertUnique(workstreams, "config.workstreams");

  const copilot = config.copilot === undefined ? {} : object(config.copilot, "config.copilot");
  if (config.copilot !== undefined) {
    assertNoUnknownKeys(copilot, ["binary", "timeoutMs"], "config.copilot");
  }
  if (copilot.binary !== undefined && (typeof copilot.binary !== "string" || copilot.binary.trim() === "")) {
    throw new TypeError("config.copilot.binary must be a non-empty string");
  }
  if (copilot.timeoutMs !== undefined && (!Number.isSafeInteger(copilot.timeoutMs) || copilot.timeoutMs <= 0)) {
    throw new TypeError("config.copilot.timeoutMs must be a positive integer");
  }

  return {
    version: CONFIG_VERSION,
    project: { id: projectId },
    permissions: normalizePermissions(config.permissions, "config.permissions"),
    copilot: {
      binary: copilot.binary ?? "copilot",
      timeoutMs: copilot.timeoutMs ?? 0,
    },
    // Declaring a sandbox does not enable it. Execution stays unsandboxed until
    // a command is invoked with --sandbox, so the escalation - and the decision
    // not to escalate - are both explicit.
    sandbox: config.sandbox === undefined
      ? undefined
      : normalizeSandbox(config.sandbox, "config.sandbox"),
    workstreams,
  };
}

export function configPath(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    throw new TypeError("projectRoot must be an explicit path");
  }
  return path.resolve(projectRoot, CONFIG_DIRECTORY, CONFIG_FILENAME);
}

export async function loadConfig(projectRoot, {
  pinDirectoryImpl = pinDirectory,
  readVerifiedFileImpl = readVerifiedFile,
  beforeOpen,
  beforeUse,
} = {}) {
  const filename = configPath(projectRoot);
  const pin = await pinDirectoryImpl(projectRoot);
  let parsed;
  try {
    parsed = JSON.parse(await readVerifiedFileImpl(pin, filename, { beforeOpen, beforeUse }));
  } catch (error) {
    if (error instanceof SyntaxError) {
      error.message = `Invalid JSON in ${filename}: ${error.message}`;
    }
    throw error;
  } finally {
    await releasePin(pin);
  }
  return validateConfig(parsed);
}
