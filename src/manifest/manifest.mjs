import path from "node:path";
import { validateId } from "../config/config.mjs";
import { pinDirectory, readVerifiedFile, releasePin, verifyDescendant } from "../security/path-security.mjs";

export const MANIFEST_VERSION = 1;

const TASK_KEYS = ["id", "route", "prompt", "promptFile", "skills", "dependsOn", "stop"];
const ROUTE_KEYS = ["project", "workstream", "role"];
const STOP_KEYS = ["maxRounds", "maxDurationMs", "maxNoOpRounds"];

export class ManifestError extends TypeError {
  constructor(message, code = "INVALID_MANIFEST") {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}

function object(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ManifestError(`${label} must be an object`);
  }
  return value;
}

function assertNoUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new ManifestError(`${label} contains unknown key: ${unknown}`);
  }
}

function identifier(value, label) {
  try {
    return validateId(value, label);
  } catch (error) {
    throw new ManifestError(error.message);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ManifestError(`${label} must be a positive integer`);
  }
  return value;
}

function assertUniqueStrings(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item)) throw new ManifestError(`${label} contains duplicate entry "${item}"`);
    seen.add(item);
  }
}

function validateRoute(value, label) {
  object(value, label);
  assertNoUnknownKeys(value, ROUTE_KEYS, label);
  for (const key of ROUTE_KEYS) {
    if (!Object.hasOwn(value, key)) {
      throw new ManifestError(`${label}.${key} is required`);
    }
  }
  return {
    project: identifier(value.project, `${label}.project`),
    workstream: identifier(value.workstream, `${label}.workstream`),
    role: identifier(value.role, `${label}.role`),
  };
}

function validateStop(value, label) {
  object(value, label);
  assertNoUnknownKeys(value, STOP_KEYS, label);
  const declared = STOP_KEYS.filter((key) => Object.hasOwn(value, key));
  // Bounded execution is a project invariant: an empty stop object would
  // silently declare no bound at all, so it is rejected rather than ignored.
  if (declared.length === 0) {
    throw new ManifestError(`${label} must declare at least one of: ${STOP_KEYS.join(", ")}`);
  }
  return Object.fromEntries(
    declared.map((key) => [key, positiveInteger(value[key], `${label}.${key}`)]),
  );
}

function validateTask(value, index) {
  const label = `manifest.tasks[${index}]`;
  object(value, label);
  assertNoUnknownKeys(value, TASK_KEYS, label);

  const id = identifier(value.id, `${label}.id`);
  const route = validateRoute(value.route, `${label}.route`);

  const hasPrompt = Object.hasOwn(value, "prompt");
  const hasPromptFile = Object.hasOwn(value, "promptFile");
  if (hasPrompt === hasPromptFile) {
    throw new ManifestError(`${label} must declare exactly one of prompt or promptFile`);
  }
  if (hasPrompt && (typeof value.prompt !== "string" || value.prompt.trim() === "")) {
    throw new ManifestError(`${label}.prompt must be a non-empty string`);
  }
  if (hasPromptFile && (typeof value.promptFile !== "string" || value.promptFile.trim() === "")) {
    throw new ManifestError(`${label}.promptFile must be a non-empty path`);
  }

  let skills;
  if (Object.hasOwn(value, "skills")) {
    if (
      !Array.isArray(value.skills)
      || value.skills.some((skill) => typeof skill !== "string" || skill.trim() === "")
    ) {
      throw new ManifestError(`${label}.skills must be an array of non-empty strings`);
    }
    assertUniqueStrings(value.skills, `${label}.skills`);
    skills = [...value.skills];
  }

  let dependsOn;
  if (Object.hasOwn(value, "dependsOn")) {
    if (!Array.isArray(value.dependsOn)) {
      throw new ManifestError(`${label}.dependsOn must be an array of task IDs`);
    }
    dependsOn = value.dependsOn.map((dependency, dependencyIndex) =>
      identifier(dependency, `${label}.dependsOn[${dependencyIndex}]`));
    assertUniqueStrings(dependsOn, `${label}.dependsOn`);
  }

  return {
    id,
    route,
    ...(hasPrompt ? { prompt: value.prompt } : { promptFile: value.promptFile }),
    ...(skills === undefined ? {} : { skills }),
    dependsOn: dependsOn ?? [],
    ...(Object.hasOwn(value, "stop") ? { stop: validateStop(value.stop, `${label}.stop`) } : {}),
  };
}

function assertResolvableGraph(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new ManifestError(`task ${task.id} cannot depend on itself`, "UNRESOLVABLE_GRAPH");
      }
      if (!byId.has(dependency)) {
        throw new ManifestError(
          `task ${task.id} has unknown dependency: ${dependency}`,
          "UNRESOLVABLE_GRAPH",
        );
      }
    }
  }
  // Cycles are rejected here rather than at execution time so that an
  // unrunnable manifest fails before any process is spawned.
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail) => {
    if (visiting.has(id)) {
      throw new ManifestError(
        `manifest task graph contains a cycle: ${[...trail, id].join(" -> ")}`,
        "UNRESOLVABLE_GRAPH",
      );
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id, []);
}

export function validateManifest(input) {
  const manifest = object(input, "manifest");
  assertNoUnknownKeys(manifest, ["version", "id", "tasks"], "manifest");
  if (manifest.version !== MANIFEST_VERSION) {
    throw new ManifestError(`manifest.version must be ${MANIFEST_VERSION}`);
  }
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
    throw new ManifestError("manifest.tasks must be a non-empty array");
  }
  const tasks = manifest.tasks.map(validateTask);
  assertUniqueStrings(tasks.map((task) => task.id), "manifest.tasks");
  assertResolvableGraph(tasks);

  return {
    version: MANIFEST_VERSION,
    ...(Object.hasOwn(manifest, "id") ? { id: identifier(manifest.id, "manifest.id") } : {}),
    tasks,
  };
}

/**
 * Reads and validates a manifest through the same pinned-directory primitives
 * as project configuration, so a symlinked or swapped path fails closed before
 * any task runs.
 */
export async function loadManifest(projectRoot, manifestPath, {
  pinDirectoryImpl = pinDirectory,
  readVerifiedFileImpl = readVerifiedFile,
} = {}) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    throw new ManifestError("projectRoot must be an explicit path");
  }
  if (typeof manifestPath !== "string" || manifestPath.trim() === "") {
    throw new ManifestError("manifestPath must be an explicit path");
  }
  const filename = path.resolve(projectRoot, manifestPath);
  const pin = await pinDirectoryImpl(projectRoot);
  let parsed;
  try {
    parsed = JSON.parse(await readVerifiedFileImpl(pin, filename));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ManifestError(`Invalid JSON in ${filename}: ${error.message}`);
    }
    throw error;
  } finally {
    await releasePin(pin);
  }
  return validateManifest(parsed);
}

/**
 * Resolves every task's prompt text. Prompt files are resolved relative to the
 * project root and must stay contained within it, so a manifest cannot read an
 * arbitrary file outside the project.
 */
export async function resolveTaskPrompts(projectRoot, manifest, {
  pinDirectoryImpl = pinDirectory,
  readVerifiedFileImpl = readVerifiedFile,
  verifyDescendantImpl = verifyDescendant,
} = {}) {
  const pin = await pinDirectoryImpl(projectRoot);
  try {
    const tasks = [];
    for (const task of manifest.tasks) {
      if (task.prompt !== undefined) {
        tasks.push({ ...task });
        continue;
      }
      const candidate = path.resolve(projectRoot, task.promptFile);
      await verifyDescendantImpl(pin, candidate, { allowMissing: false });
      const prompt = await readVerifiedFileImpl(pin, candidate);
      if (prompt.trim() === "") {
        throw new ManifestError(
          `manifest task ${task.id} promptFile resolved to an empty prompt: ${task.promptFile}`,
        );
      }
      tasks.push({ ...task, prompt });
    }
    return { ...manifest, tasks };
  } finally {
    await releasePin(pin);
  }
}
