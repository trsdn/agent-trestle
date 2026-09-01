import assert from "node:assert/strict";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeScratchRoot } from "../helpers/scratch.mjs";
import { createAuditSegmentWriter } from "../../src/audit/audit.mjs";
import { loadAgentDefinition } from "../../src/config/agent-definition.mjs";
import { loadConfig } from "../../src/config/config.mjs";
import { resolveSkillPaths } from "../../src/config/skills.mjs";
import { PathSecurityError } from "../../src/security/path-security.mjs";

const workRoot = await makeScratchRoot("secure-file-handle-races");
const CONFIG = JSON.stringify({
  version: 1,
  project: { id: "safe-project" },
  workstreams: [{ id: "safe", path: "safe", roles: [{ id: "builder", agent: "builder" }] }],
});
const AGENT = "---\nmodel: safe-model\nskills: [safe-skill]\n---\nSafe agent\n";
const SKILL = "# Safe skill\nNever trust a pathname after validation.\n";

async function prepare(name) {
  const root = path.join(workRoot, name, "project");
  const outside = path.join(workRoot, name, "outside");
  await rm(path.join(workRoot, name), { recursive: true, force: true });
  await mkdir(path.join(root, ".trestle"), { recursive: true });
  await mkdir(path.join(root, ".github", "agents"), { recursive: true });
  await mkdir(path.join(root, ".github", "skills", "safe-skill"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, ".trestle", "config.json"), CONFIG);
  await writeFile(path.join(root, ".github", "agents", "builder.agent.md"), AGENT);
  await writeFile(path.join(root, ".github", "skills", "safe-skill", "SKILL.md"), SKILL);
  return { root, outside };
}

async function replaceWithOutsidePath(target, outsideTarget) {
  await rm(target, { force: true });
  try {
    await symlink(outsideTarget, target);
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    try {
      await lstat(target);
    } catch (lstatError) {
      if (lstatError.code === "EPERM") return;
    }
    throw error;
  }
}

function replaceWithOutside(target, outsideTarget) {
  let replaced = false;
  return async ({ path: candidate }) => {
    if (replaced || candidate !== target) return;
    replaced = true;
    await replaceWithOutsidePath(target, outsideTarget);
  };
}

async function expectSecureOpenRejection(load, target, outsideTarget) {
  await assert.rejects(load, PathSecurityError);
  assert.equal(await readFile(outsideTarget, "utf8"), "OUTSIDE CONTENT\n");
  await rm(target, { force: true });
}

test("config, agent, and SKILL.md reads reject a replacement injected before secure open", async () => {
  const { root, outside } = await prepare("project-files");
  try {
    const config = path.join(root, ".trestle", "config.json");
    const agent = path.join(root, ".github", "agents", "builder.agent.md");
    const skill = path.join(root, ".github", "skills", "safe-skill", "SKILL.md");
    const outsideConfig = path.join(outside, "config.json");
    const outsideAgent = path.join(outside, "builder.agent.md");
    const outsideSkill = path.join(outside, "SKILL.md");
    await Promise.all([
      writeFile(outsideConfig, "OUTSIDE CONTENT\n"),
      writeFile(outsideAgent, "OUTSIDE CONTENT\n"),
      writeFile(outsideSkill, "OUTSIDE CONTENT\n"),
    ]);

    await expectSecureOpenRejection(
      () => loadConfig(root, { beforeOpen: replaceWithOutside(config, outsideConfig) }),
      config,
      outsideConfig,
    );
    await writeFile(config, CONFIG);

    await expectSecureOpenRejection(
      () => loadAgentDefinition(root, "builder", { beforeOpen: replaceWithOutside(agent, outsideAgent) }),
      agent,
      outsideAgent,
    );
    await writeFile(agent, AGENT);

    await expectSecureOpenRejection(
      () => resolveSkillPaths(root, ["safe-skill"], { beforeOpen: replaceWithOutside(skill, outsideSkill) }),
      skill,
      outsideSkill,
    );
  } finally {
    await rm(path.join(workRoot, "project-files"), { recursive: true, force: true });
  }
});

test("config rechecks handle identity when a replacement is injected after open but before use", async () => {
  const { root, outside } = await prepare("config-before-use");
  const config = path.join(root, ".trestle", "config.json");
  const outsideConfig = path.join(outside, "config.json");
  await writeFile(outsideConfig, "OUTSIDE CONTENT\n");
  try {
    await assert.rejects(
      () => loadConfig(root, { beforeUse: replaceWithOutside(config, outsideConfig) }),
      PathSecurityError,
    );
    assert.equal(await readFile(outsideConfig, "utf8"), "OUTSIDE CONTENT\n");
  } finally {
    await rm(path.join(workRoot, "config-before-use"), { recursive: true, force: true });
  }
});

function auditWriter(auditRoot, options = {}) {
  return createAuditSegmentWriter({
    auditRoot,
    runId: "run-1",
    taskId: "task-1",
    writerId: "writer-1",
    idGenerator: () => "segment-1",
    ...options,
  });
}

test("audit segment reads and appends reject injected outside symlinks without touching outside content", async () => {
  const { root, outside } = await prepare("audit-segments");
  const outsideSegment = path.join(outside, "segment.ndjson");
  await writeFile(outsideSegment, "OUTSIDE CONTENT\n");
  try {
    const auditRoot = path.join(root, "audit");
    const seeded = auditWriter(auditRoot);
    await seeded.append({ type: "seed" });

    const readRace = auditWriter(auditRoot, {
      beforeOpen: replaceWithOutside(seeded.segmentPath, outsideSegment),
    });
    await assert.rejects(() => readRace.verify(), PathSecurityError);
    assert.equal(await readFile(outsideSegment, "utf8"), "OUTSIDE CONTENT\n");

    const appendAudit = auditWriter(path.join(root, "append-audit"), {
      beforeUse: ({ operation, path: candidate }) => operation === "segment-append"
        ? replaceWithOutside(candidate, outsideSegment)({ path: candidate })
        : undefined,
    });
    await assert.rejects(() => appendAudit.append({ type: "append" }), PathSecurityError);
    assert.equal(await readFile(outsideSegment, "utf8"), "OUTSIDE CONTENT\n");
  } finally {
    await rm(path.join(workRoot, "audit-segments"), { recursive: true, force: true });
  }
});

test("audit lock creation rejects an injected outside symlink and preserves rollover safety", async () => {
  const { root, outside } = await prepare("audit-lock");
  const outsideLock = path.join(outside, "segment.lock");
  await writeFile(outsideLock, "OUTSIDE CONTENT\n");
  try {
    const audit = auditWriter(path.join(root, "audit"), {
      beforeOpen: ({ operation, path: candidate }) => operation === "lock"
        ? replaceWithOutside(candidate, outsideLock)({ path: candidate })
        : undefined,
    });
    await assert.rejects(() => audit.append({ type: "start" }), PathSecurityError);
    assert.equal(await readFile(outsideLock, "utf8"), "OUTSIDE CONTENT\n");
  } finally {
    await rm(path.join(workRoot, "audit-lock"), { recursive: true, force: true });
  }
});
