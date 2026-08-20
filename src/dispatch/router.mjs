import path from "node:path";
import { mergePermissions } from "../config/permissions.mjs";
import { isWithin, pinDirectory, releasePin, verifyDescendant } from "../security/path-security.mjs";

export function resolveRoute(config, { projectId, workstreamId, roleId } = {}) {
  if (!projectId || !workstreamId || !roleId) {
    throw new TypeError("projectId, workstreamId, and roleId are required; IDs are never inferred from paths");
  }
  if (config.project.id !== projectId) {
    throw new Error(`Unknown project ID "${projectId}"`);
  }
  const workstream = config.workstreams.find((candidate) => candidate.id === workstreamId);
  if (!workstream) throw new Error(`Unknown workstream ID "${workstreamId}" in project "${projectId}"`);
  const role = workstream.roles.find((candidate) => candidate.id === roleId);
  if (!role) throw new Error(`Unknown role ID "${roleId}" in workstream "${workstreamId}"`);

  return {
    projectId,
    workstreamId,
    roleId,
    agentId: role.agent,
    workstreamPath: workstream.path,
    configuredSkills: [...(role.skills ?? [])].sort((a, b) => a.localeCompare(b)),
    permissions: mergePermissions(config.permissions, workstream.permissions, role.permissions),
  };
}

export async function resolveProjectDirectory(projectRoot) {
  if (!projectRoot) throw new TypeError("projectRoot is required");
  return pinDirectory(path.resolve(projectRoot));
}

export async function resolveConfigDirectory(projectRoot) {
  const project = await resolveProjectDirectory(projectRoot);
  try {
    const configured = path.resolve(project.path, ".trestle");
    if (!isWithin(project.path, configured)) throw new Error("Config path escapes project root");
    const config = await pinDirectory(configured);
    try {
      if (!isWithin(project.realPath, config.realPath)) {
        throw new Error("Config real path escapes project root");
      }
      return config.path;
    } finally {
      await releasePin(config);
    }
  } finally {
    await releasePin(project);
  }
}

export async function resolveWorkstreamDirectory(projectRoot, route) {
  const project = await resolveProjectDirectory(projectRoot);
  try {
    const workstreamPath = route.workstreamPath ?? route.path;
    if (typeof workstreamPath !== "string" || workstreamPath.length === 0) {
      throw new TypeError("workstreamPath is required");
    }
    const resolved = path.resolve(project.path, workstreamPath);
    if (!isWithin(project.path, resolved)) {
      throw new Error(`Workstream path escapes project root: ${workstreamPath}`);
    }
    await verifyDescendant(project, resolved, { allowMissing: false });
    const workstream = await pinDirectory(resolved);
    try {
      if (!isWithin(project.realPath, workstream.realPath)) {
        throw new Error(`Workstream real path escapes project root: ${workstreamPath}`);
      }
      return workstream.path;
    } finally {
      await releasePin(workstream);
    }
  } finally {
    await releasePin(project);
  }
}
