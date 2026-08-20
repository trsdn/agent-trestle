import path from "node:path";
import { pinDirectory, readVerifiedFile, releasePin } from "../security/path-security.mjs";

export const SKILL_LOCATIONS = Object.freeze([
  [".github", "skills"],
  [".copilot", "skills"],
]);

export function selectSkills({ declared = [], configured = [], requested = [] } = {}) {
  for (const [label, value] of Object.entries({ declared, configured, requested })) {
    if (!Array.isArray(value) || value.some((skill) => typeof skill !== "string" || skill.trim() === "")) {
      throw new TypeError(`${label} skills must be an array of non-empty strings`);
    }
  }
  const allowed = new Set([...declared, ...configured]);
  const selected = requested.length === 0 ? [...allowed] : requested;
  const denied = selected.filter((skill) => !allowed.has(skill));
  if (denied.length > 0) {
    throw new Error(`Requested skills are not declared or configured: ${[...new Set(denied)].sort().join(", ")}`);
  }
  return [...new Set(selected)].sort((a, b) => a.localeCompare(b));
}

export async function resolveSkillPaths(projectRoot, skills, {
  pinDirectoryImpl = pinDirectory,
  readVerifiedFileImpl = readVerifiedFile,
  beforeOpen,
  beforeUse,
} = {}) {
  const pin = await pinDirectoryImpl(projectRoot);
  const resolved = [];
  try {
    for (const skill of [...new Set(skills)].sort((a, b) => a.localeCompare(b))) {
      if (!/^[a-zA-Z0-9._-]+$/.test(skill)) throw new TypeError(`Invalid skill ID "${skill}"`);
      let found;
      for (const segments of SKILL_LOCATIONS) {
        const candidate = path.resolve(projectRoot, ...segments, skill, "SKILL.md");
        try {
          found = {
            id: skill,
            path: candidate,
            content: await readVerifiedFileImpl(pin, candidate, { beforeOpen, beforeUse }),
          };
          break;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      if (!found) throw new Error(`Skill "${skill}" was not found in the project skill locations`);
      resolved.push(found);
    }
  } finally {
    await releasePin(pin);
  }
  return resolved;
}
