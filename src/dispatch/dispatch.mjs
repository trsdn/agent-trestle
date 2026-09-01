import { loadAgentDefinition } from "../config/agent-definition.mjs";
import { copilotPermissionArgs } from "../config/permissions.mjs";
import { resolveSkillPaths, selectSkills } from "../config/skills.mjs";
import { runCopilot } from "../copilot/process-adapter.mjs";
import { summarizeExecutionForAudit } from "../audit/recorder.mjs";
import { describeSandbox } from "../sandbox/container.mjs";
import { pinDirectory, releasePin } from "../security/path-security.mjs";
import { resolveRoute, resolveWorkstreamDirectory } from "./router.mjs";

async function resolveIsolatedDirectory(candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new TypeError("workingDirectory must be an explicit path");
  }
  const pin = await pinDirectory(candidate);
  try {
    return pin.path;
  } finally {
    await releasePin(pin);
  }
}

export async function dispatch({
  config,
  projectRoot,
  projectId,
  workstreamId,
  roleId,
  prompt,
  requestedSkills = [],
  binary,
  runner,
  spawnImpl,
  modelLogPath,
  signal,
  audit,
  workingDirectory,
  loadAgent = loadAgentDefinition,
  resolveSkills = resolveSkillPaths,
  run = runCopilot,
  sandbox,
} = {}) {
  const route = resolveRoute(config, { projectId, workstreamId, roleId });
  // An explicit workingDirectory isolates this dispatch in a caller-provisioned
  // checkout (see the worktree fleet). The caller owns proving containment of
  // that path; it is still pinned here so a swapped or symlinked directory
  // fails closed before a process is pointed at it.
  const cwd = workingDirectory === undefined
    ? await resolveWorkstreamDirectory(projectRoot, route)
    : await resolveIsolatedDirectory(workingDirectory);
  const agent = await loadAgent(projectRoot, route.agentId);
  const selectedSkills = selectSkills({
    declared: agent.skills,
    configured: route.configuredSkills,
    requested: requestedSkills,
  });
  const skills = await resolveSkills(projectRoot, selectedSkills);
  const permissionArgs = copilotPermissionArgs(route.permissions);
  const skillPrompt = skills.length === 0
    ? prompt
    : `${prompt}\n\nUse these project skills:\n${skills.map((skill) =>
      skill.content === undefined
        ? `- ${skill.id}: ${skill.path}`
        : `- ${skill.id}:\n${skill.content}`,
    ).join("\n")}`;

  // Recorded before the process starts so that a dispatch which never settles
  // still leaves evidence of what was granted and where it was pointed.
  const identity = {
    route,
    agent: { id: agent.id, path: agent.path, model: agent.model },
    skills: skills.map(({ content: ignored, ...skill }) => skill),
    permissions: route.permissions,
    sandbox: sandbox === undefined ? null : describeSandbox(sandbox),
  };
  await audit?.record("dispatch.started", {
    ...identity,
    cwd,
    binary: binary ?? config.copilot.binary,
    permissionArgs,
    timeoutMs: config.copilot.timeoutMs,
  });

  const execution = await run({
    prompt: skillPrompt,
    agent: route.agentId,
    model: agent.model,
    cwd,
    binary: binary ?? config.copilot.binary,
    args: permissionArgs,
    timeoutMs: config.copilot.timeoutMs,
    runner,
    spawnImpl,
    modelLogPath,
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(signal === undefined ? {} : { signal }),
  });

  await audit?.record("dispatch.settled", {
    route,
    agent: { id: agent.id },
    execution: summarizeExecutionForAudit(execution),
  });

  return { ...identity, execution };
}
