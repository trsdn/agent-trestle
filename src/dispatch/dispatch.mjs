import { loadAgentDefinition } from "../config/agent-definition.mjs";
import { copilotPermissionArgs } from "../config/permissions.mjs";
import { resolveSkillPaths, selectSkills } from "../config/skills.mjs";
import { runCopilot } from "../copilot/process-adapter.mjs";
import { resolveRoute, resolveWorkstreamDirectory } from "./router.mjs";

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
  loadAgent = loadAgentDefinition,
  resolveSkills = resolveSkillPaths,
  run = runCopilot,
} = {}) {
  const route = resolveRoute(config, { projectId, workstreamId, roleId });
  const cwd = await resolveWorkstreamDirectory(projectRoot, route);
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
  });

  return {
    route,
    agent: { id: agent.id, path: agent.path, model: agent.model },
    skills: skills.map(({ content: ignored, ...skill }) => skill),
    permissions: route.permissions,
    execution,
  };
}
