import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadAgentDefinition } from "../config/agent-definition.mjs";
import { resolveSkillPaths, selectSkills } from "../config/skills.mjs";

// The exact diff is already embedded in the reviewer prompt, so the reviewer
// needs no tools. Keeping the CLI allowlist empty avoids version-sensitive
// builtin tool identifiers while still filtering out every tool by default.
export const REVIEWER_TOOL_ALLOWLIST = Object.freeze([]);

const REVIEWER_HOME_PREFIX = "agent-trestle-reviewer-";

// Built-in Copilot CLI agents ship with the binary itself and resolve
// regardless of COPILOT_HOME/cwd, so they never need a project lookup. Any
// reviewer ID outside this fixed set is treated as a project-defined custom
// agent and MUST be validated against the repository (see prepareReviewerAgent
// below); there is no silent fallback for an unresolvable ID.
export const BUILTIN_REVIEWER_AGENTS = Object.freeze([
  "explore",
  "task",
  "code-review",
  "research",
  "rubber-duck",
]);

// Strict allowlist for the reviewer's child environment: only what the CLI
// process functionally needs to run survives. Everything else - including
// anything a blocklist could miss - is dropped by construction.
const REVIEWER_ENV_ALLOWLIST = Object.freeze([
  "PATH", // locate the copilot binary and any tool it shells out to
  "TMPDIR", "TEMP", "TMP", // OS scratch-space location, kept consistent with the parent
  "SystemRoot", "windir", "PATHEXT", "SystemDrive", // Windows process essentials
  "LANG", "LANGUAGE",
  "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_TIME", "LC_COLLATE", "LC_NUMERIC", "LC_MONETARY", // text encoding/formatting, not secret-bearing
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy", // outbound network access in proxied environments
]);

// Defense-in-depth backstop over the allowlist above: even if a future edit
// widens REVIEWER_ENV_ALLOWLIST with a prefix/pattern instead of an exact
// name, these never survive into the reviewer's environment.
const REVIEWER_ENV_DENY_PATTERNS = Object.freeze([
  /^NODE_/i, // covers NODE_OPTIONS (arbitrary Node flags/require hooks) and every other NODE_* var
  /^OTEL_/i,
  /^COPILOT_OTEL_/i,
]);

// Case-insensitive backstop: an environment variable whose *name* looks like
// a secret is never forwarded, regardless of whether it happens to match an
// allowlisted name above.
const REVIEWER_ENV_SECRET_NAME_PATTERN =
  /token|secret|key|password|passwd|credential|auth|cert|private/i;

function assertReviewerHomeOutsideRepository(reviewerHome, repoRoot) {
  if (typeof reviewerHome !== "string" || !path.isAbsolute(reviewerHome)) {
    throw new TypeError("reviewerHome must be an absolute path");
  }
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) {
    throw new TypeError("repoRoot must be an absolute path");
  }
  const relative = path.relative(path.resolve(repoRoot), path.resolve(reviewerHome));
  if (
    relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    throw new Error("reviewerHome must be outside the reviewed repository");
  }
}

export async function createReviewerHome() {
  const reviewerHome = await mkdtemp(path.join(os.tmpdir(), REVIEWER_HOME_PREFIX));
  await chmod(reviewerHome, 0o700);
  return reviewerHome;
}

export async function cleanupReviewerHome(reviewerHome) {
  if (typeof reviewerHome !== "string" || !path.isAbsolute(reviewerHome)) {
    throw new TypeError("reviewerHome must be an absolute path");
  }
  await rm(reviewerHome, { recursive: true, force: true });
}

// Builds the reviewer child's entire environment from a strict allowlist
// instead of trying to enumerate every variable to block. Only the small set
// of names in REVIEWER_ENV_ALLOWLIST can ever be copied from the parent, and
// even those are re-checked against the deny patterns and the secret-name
// pattern before being kept, so no single list has to be exhaustive on its
// own. COPILOT_HOME is then forced to the ephemeral reviewer home regardless
// of what the parent had set.
function findEnvironmentKey(environment, canonicalName, platform) {
  if (Object.hasOwn(environment, canonicalName)) return canonicalName;
  if (platform !== "win32") return null;
  const foldedName = canonicalName.toLowerCase();
  return Object.keys(environment).find((name) => name.toLowerCase() === foldedName) ?? null;
}

function environmentNameDenied(name) {
  return (
    REVIEWER_ENV_DENY_PATTERNS.some((pattern) => pattern.test(name))
    || REVIEWER_ENV_SECRET_NAME_PATTERN.test(name)
  );
}

export function scrubReviewerEnvironment(
  environment = process.env,
  reviewerHome,
  { platform = process.platform } = {},
) {
  const env = {};
  const copiedNames = new Set();
  for (const name of REVIEWER_ENV_ALLOWLIST) {
    const foldedName = platform === "win32" ? name.toLowerCase() : name;
    if (copiedNames.has(foldedName)) continue;
    copiedNames.add(foldedName);
    const sourceName = findEnvironmentKey(environment, name, platform);
    if (!sourceName || environmentNameDenied(name) || environmentNameDenied(sourceName)) continue;
    env[name] = environment[sourceName];
  }
  env.COPILOT_HOME = reviewerHome;
  return Object.freeze(env);
}

function yamlSafeScalar(value) {
  return JSON.stringify(String(value));
}

// Renders a validated project agent definition (plus its resolved skill
// content) into a minimal, sanitized `.agent.md`. Only `model` and
// `description` are carried into the rebuilt frontmatter: any `tools`,
// `mcp-servers`, or other capability-widening keys the source file declared
// are dropped rather than copied, so the reviewer's capabilities can only
// ever come from the CLI's own `--available-tools`/`--deny-tool`/
// `--disable-builtin-mcps` flags, never from the reviewed project's own
// agent file. Skill content is folded into the body as inert markdown text
// (never into the fenced review prompt, which is protocol-sensitive).
export function sanitizeReviewerAgentDefinition(agent, skills = []) {
  const description =
    typeof agent.frontmatter?.description === "string" && agent.frontmatter.description.trim() !== ""
      ? agent.frontmatter.description
      : `Project reviewer agent "${agent.id}"`;
  const skillSection = skills.length === 0
    ? ""
    : `\n\n## Project skills\n${skills
      .map((skill) => `### ${skill.id}\n${skill.content}`)
      .join("\n\n")}`;
  const frontmatter = [
    "---",
    `model: ${yamlSafeScalar(agent.model)}`,
    `description: ${yamlSafeScalar(description)}`,
    "---",
  ].join("\n");
  return `${frontmatter}\n${agent.body.trim()}${skillSection}\n`;
}

// Makes a project-defined reviewer agent discoverable to the Copilot CLI
// without ever moving the reviewer's cwd into the reviewed repository.
// Built-in CLI agents (BUILTIN_REVIEWER_AGENTS) resolve on their own and skip
// this entirely - no repository access is needed to use one. Anything else is
// treated as a project custom agent: it is loaded and validated with the same
// secure, symlink-safe loaders used for producer agents (loadAgentDefinition,
// resolveSkillPaths), sanitized, and materialized as a user-level custom agent
// under the reviewer's own ephemeral `$COPILOT_HOME/agents/<id>.agent.md` -
// the documented location the Copilot CLI already searches regardless of cwd.
// An ID that is neither builtin nor a loadable project agent fails closed
// here, before any reviewer process is spawned.
export async function prepareReviewerAgent({
  repoRoot,
  reviewer,
  reviewerHome,
  loadAgent = loadAgentDefinition,
  resolveSkills = resolveSkillPaths,
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  chmodImpl = chmod,
} = {}) {
  if (typeof reviewer !== "string" || reviewer.length === 0) {
    throw new TypeError("reviewer is required");
  }
  if (BUILTIN_REVIEWER_AGENTS.includes(reviewer)) {
    return Object.freeze({ builtin: true, reviewer });
  }
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) {
    throw new TypeError("repoRoot must be an absolute path");
  }
  if (typeof reviewerHome !== "string" || !path.isAbsolute(reviewerHome)) {
    throw new TypeError("reviewerHome must be an absolute path");
  }
  let agent;
  try {
    agent = await loadAgent(repoRoot, reviewer);
  } catch (error) {
    throw new Error(
      `Reviewer agent "${reviewer}" is not a builtin agent and could not be loaded from the project`,
      { cause: error },
    );
  }
  const selectedSkills = selectSkills({ declared: agent.skills });
  const skills = await resolveSkills(repoRoot, selectedSkills);
  const definition = sanitizeReviewerAgentDefinition(agent, skills);
  const agentsDir = path.join(reviewerHome, "agents");
  await mkdirImpl(agentsDir, { recursive: true, mode: 0o700 });
  await chmodImpl(agentsDir, 0o700);
  const agentPath = path.join(agentsDir, `${reviewer}.agent.md`);
  await writeFileImpl(agentPath, definition, { mode: 0o600 });
  await chmodImpl(agentPath, 0o600);
  return Object.freeze({
    builtin: false,
    reviewer,
    path: agentPath,
    skills: Object.freeze(skills.map((skill) => skill.id)),
  });
}

export function buildReadOnlyReviewerCommand({
  reviewer,
  prompt,
  cwd,
  repoRoot = cwd,
  reviewerHome,
  executable = "copilot",
  environment = process.env,
  platform = process.platform,
} = {}) {
  if (typeof reviewer !== "string" || reviewer.length === 0) {
    throw new TypeError("reviewer is required");
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new TypeError("prompt is required");
  }
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new TypeError("cwd must be an absolute path");
  }
  if (typeof reviewerHome !== "string" || !path.isAbsolute(reviewerHome)) {
    throw new TypeError("reviewerHome must be an absolute path");
  }
  if (path.resolve(cwd) !== path.resolve(reviewerHome)) {
    throw new Error("cwd must be the isolated reviewer home");
  }
  assertReviewerHomeOutsideRepository(reviewerHome, repoRoot);
  return Object.freeze({
    executable,
    args: Object.freeze([
      "--agent",
      reviewer,
      "--no-ask-user",
      "--no-custom-instructions",
      "--no-auto-update",
      "--silent",
      "--no-remote",
      "--no-remote-export",
      "--disallow-temp-dir",
      "--disable-builtin-mcps",
      "--available-tools",
      REVIEWER_TOOL_ALLOWLIST.join(","),
      "--deny-tool",
      "write",
      "--deny-tool",
      "shell",
      "-p",
      prompt,
    ]),
    options: Object.freeze({
      shell: false,
      readOnly: true,
      cwd,
      env: scrubReviewerEnvironment(environment, reviewerHome, { platform }),
    }),
  });
}
