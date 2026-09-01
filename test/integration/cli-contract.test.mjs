import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import path from "node:path";
import test from "node:test";
import { makeScratchRoot } from "../helpers/scratch.mjs";
import * as library from "../../src/index.mjs";
import { EXIT_CODES, main, runCli } from "../../src/cli/main.mjs";

const scratchRoot = await makeScratchRoot("cli-contract");
const fixtureRoot = path.join(scratchRoot, "cli-contract");

function capture(cwd = fixtureRoot) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

test("root library exposes each stable public module", () => {
  for (const name of [
    "audit", "config", "copilot", "dashboard", "dispatch", "ownership",
    "review", "sandbox", "scheduler", "state", "worktrees",
  ]) {
    assert.equal(typeof library[name], "object", `${name} export`);
  }
});

test("CLI identifies only the collision-resistant agent-trestle command", async () => {
  const help = capture();
  assert.equal(await runCli(["--help"], help.io), EXIT_CODES.SUCCESS);
  assert.match(help.stdout(), /^Usage: agent-trestle /);
  assert.doesNotMatch(help.stdout(), /^Usage: trestle /);

  const pkg = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  assert.deepEqual(pkg.bin, {
    "agent-trestle": "./src/cli/agent-trestle.mjs",
  });
});

test("CLI reports its own version and links back to its source", async () => {
  const pkg = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  const repository = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");

  const help = capture();
  assert.equal(await runCli(["--help"], help.io), EXIT_CODES.SUCCESS);
  assert.ok(help.stdout().includes(pkg.version), "help states the version");
  assert.ok(help.stdout().includes(repository), "help links the repository");
  assert.ok(help.stdout().includes(pkg.bugs.url), "help links the issue tracker");

  const plain = capture();
  assert.equal(await runCli(["--version"], plain.io), EXIT_CODES.SUCCESS);
  assert.equal(plain.stdout().trim(), pkg.version);

  const structured = capture();
  assert.equal(await runCli(["--version", "--json"], structured.io), EXIT_CODES.SUCCESS);
  assert.deepEqual(JSON.parse(structured.stdout()), {
    name: pkg.name,
    version: pkg.version,
    repository,
    bugs: pkg.bugs.url,
    license: pkg.license,
  });
});

test("init, validate, and resolve form a working least-privilege flow", async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });

  const initialized = capture();
  assert.equal(await runCli(["init", "--json"], initialized.io), EXIT_CODES.SUCCESS);
  const initResult = JSON.parse(initialized.stdout());
  assert.deepEqual(initResult.created, [
    ".trestle/config.json",
    ".github/agents/example-builder.agent.md",
  ]);

  const config = JSON.parse(await readFile(path.join(fixtureRoot, ".trestle/config.json"), "utf8"));
  assert.equal(config.permissions.allowAllTools, false);
  assert.equal(config.permissions.nonInteractive, false);
  assert.equal(config.permissions.autoMerge, false);

  const validated = capture();
  assert.equal(await runCli(["validate", "--json"], validated.io), EXIT_CODES.SUCCESS);
  assert.equal(JSON.parse(validated.stdout()).projectId, "example-project");

  const resolved = capture();
  assert.equal(await runCli([
    "resolve",
    "--project", "example-project",
    "--workstream", "main",
    "--role", "builder",
    "--json",
  ], resolved.io), EXIT_CODES.SUCCESS);
  const route = JSON.parse(resolved.stdout()).route;
  assert.equal(route.agentId, "example-builder");
  assert.deepEqual(route.permissions, {
    allowAllTools: false,
    allowAllPaths: false,
    allowAllUrls: false,
    nonInteractive: false,
    autoMerge: false,
  });

  await rm(fixtureRoot, { recursive: true, force: true });
});

test("merge refuses by default and states which opt-in is missing", async () => {
  const projectRoot = path.join(scratchRoot, "merge-gating");
  await rm(projectRoot, { recursive: true, force: true });
  await mkdir(projectRoot, { recursive: true });
  const init = capture(projectRoot);
  assert.equal(await runCli(["init", "--json"], init.io), EXIT_CODES.SUCCESS);

  const { main } = await import("../../src/cli/main.mjs");
  const review = ["review", "--base", "main", "--head", "topic", "--producer", "a", "--reviewer", "b"];

  // The scaffolded config leaves permissions.autoMerge false, so the flag alone
  // is refused before the gate runs at all.
  const denied = capture(projectRoot);
  assert.equal(await main([...review, "--merge", "--json"], denied.io), EXIT_CODES.BLOCKED);
  assert.equal(JSON.parse(denied.stderr()).error.code, "AUTO_MERGE_UNAUTHORIZED");

  // With autoMerge granted, an ownership policy and actor are still required.
  const config = JSON.parse(await readFile(path.join(projectRoot, ".trestle", "config.json"), "utf8"));
  config.permissions.autoMerge = true;
  await writeFile(path.join(projectRoot, ".trestle", "config.json"), JSON.stringify(config));

  const unattributed = capture(projectRoot);
  assert.equal(await main([...review, "--merge", "--json"], unattributed.io), EXIT_CODES.USAGE);
  assert.match(JSON.parse(unattributed.stderr()).error.message, /--ownership FILE and --actor ID/);

  // A malformed policy is rejected before the gate runs.
  await writeFile(path.join(projectRoot, "owners.json"), JSON.stringify({ version: 2, owners: {} }));
  const badPolicy = capture(projectRoot);
  assert.equal(
    await main([...review, "--merge", "--ownership", "owners.json", "--actor", "a", "--json"], badPolicy.io),
    EXIT_CODES.USAGE,
  );
  assert.equal(JSON.parse(badPolicy.stderr()).error.code, "INVALID_OWNERSHIP_POLICY");
});

test("--sandbox refuses to run unsandboxed when no sandbox is configured", async () => {
  const projectRoot = path.join(scratchRoot, "sandbox-gating");
  await rm(projectRoot, { recursive: true, force: true });
  await mkdir(projectRoot, { recursive: true });
  const init = capture(projectRoot);
  assert.equal(await runCli(["init", "--json"], init.io), EXIT_CODES.SUCCESS);

  const configFile = path.join(projectRoot, ".trestle", "config.json");
  const scaffolded = JSON.parse(await readFile(configFile, "utf8"));
  const workstream = scaffolded.workstreams[0];
  const dispatchArgv = [
    "dispatch",
    "--project", scaffolded.project.id,
    "--workstream", workstream.id,
    "--role", workstream.roles[0].id,
    "--prompt", "do the thing",
    "--sandbox",
    "--no-audit",
    "--json",
  ];

  // Asking for containment that was never configured must fail, not silently
  // fall back to running the agent unsandboxed.
  const unconfigured = capture(projectRoot);
  assert.equal(await main(dispatchArgv, unconfigured.io), EXIT_CODES.USAGE);
  assert.match(JSON.parse(unconfigured.stderr()).error.message, /--sandbox requires a sandbox block/);

  // A sandbox that could not constrain anything is rejected when config loads.
  await writeFile(configFile, JSON.stringify({ ...scaffolded, sandbox: { image: "x", network: "host" } }));
  const hostNetwork = capture(projectRoot);
  assert.notEqual(await main(["validate", "--json"], hostNetwork.io), EXIT_CODES.SUCCESS);
  assert.match(hostNetwork.stderr(), /network must be one of none, bridge/);

  // A well-formed declaration validates, and still grants no Copilot permission.
  await writeFile(configFile, JSON.stringify({
    ...scaffolded,
    sandbox: { image: "ghcr.io/example/copilot:1" },
  }));
  const accepted = capture(projectRoot);
  assert.equal(await runCli(["validate", "--json"], accepted.io), EXIT_CODES.SUCCESS);
  const { config } = await import("../../src/config/config.mjs")
    .then(async (module) => ({ config: await module.loadConfig(projectRoot) }));
  assert.equal(config.sandbox.network, "none");
  assert.equal(config.permissions.allowAllTools, false);

  // On Windows the sandbox is not optional: an unsandboxed agent cannot be
  // spawned without a shell, and there are no process groups to bound it with,
  // so the CLI refuses rather than running it half-contained.
  const unsandboxed = capture(projectRoot);
  const code = await main(dispatchArgv.filter((arg) => arg !== "--sandbox"), unsandboxed.io);
  if (process.platform === "win32") {
    assert.equal(code, EXIT_CODES.NOT_SUPPORTED);
    assert.equal(JSON.parse(unsandboxed.stderr()).error.code, "SANDBOX_REQUIRED");
  } else {
    // Elsewhere it is allowed to proceed and fails later on the missing binary.
    assert.notEqual(code, EXIT_CODES.NOT_SUPPORTED);
  }
});

test("run requires an explicit manifest", async () => {
  const invoked = capture();
  const { main } = await import("../../src/cli/main.mjs");
  const exitCode = await main(["run", "--json"], invoked.io);
  assert.equal(exitCode, EXIT_CODES.USAGE);
  const failure = JSON.parse(invoked.stderr());
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "USAGE");
});

test("validate and doctor reject symlink project, config, and workstream paths", async () => {
  const securityRoot = path.join(scratchRoot, "cli-path-security");
  const project = path.join(securityRoot, "project");
  await rm(securityRoot, { recursive: true, force: true });
  await mkdir(project, { recursive: true });
  const initialized = capture(project);
  assert.equal(await runCli(["init", "--json"], initialized.io), EXIT_CODES.SUCCESS);

  const projectLink = path.join(securityRoot, "project-link");
  await symlink(project, projectLink);
  const linkedRoot = capture(securityRoot);
  assert.equal(
    await (await import("../../src/cli/main.mjs")).main(
      ["validate", "--root", "project-link", "--json"],
      linkedRoot.io,
    ),
    EXIT_CODES.FAILED,
  );
  assert.equal(JSON.parse(linkedRoot.stderr()).error.code, "PATH_TRAVERSAL");

  const config = JSON.parse(await readFile(path.join(project, ".trestle/config.json"), "utf8"));
  const realConfig = path.join(project, ".trestle-real");
  await rm(path.join(project, ".trestle"), { recursive: true });
  await mkdir(realConfig, { recursive: true });
  await writeFile(path.join(realConfig, "config.json"), `${JSON.stringify(config)}\n`);
  await symlink(realConfig, path.join(project, ".trestle"));
  const linkedConfig = capture(project);
  assert.equal(
    await (await import("../../src/cli/main.mjs")).main(["validate", "--json"], linkedConfig.io),
    EXIT_CODES.FAILED,
  );

  await rm(path.join(project, ".trestle"));
  await mkdir(path.join(project, ".trestle"), { recursive: true });
  config.workstreams[0].path = "linked-workstream";
  await writeFile(path.join(project, ".trestle/config.json"), `${JSON.stringify(config)}\n`);
  const outside = path.join(securityRoot, "outside");
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(project, "linked-workstream"));
  const doctor = capture(project);
  assert.equal(
    await runCli(["doctor", "--binary", process.execPath, "--json"], doctor.io),
    EXIT_CODES.ENVIRONMENT,
  );
  const projectCheck = JSON.parse(doctor.stdout()).checks.find(({ name }) => name === "project");
  assert.equal(projectCheck.ok, false);
  assert.equal(projectCheck.error.code, "PATH_TRAVERSAL");
  await rm(securityRoot, { recursive: true, force: true });
});

test("init rejects symlinked roots and symlinked init target ancestors", async () => {
  const { main } = await import("../../src/cli/main.mjs");
  const securityRoot = path.join(scratchRoot, "init-path-security");
  const project = path.join(securityRoot, "project");
  await rm(securityRoot, { recursive: true, force: true });
  await mkdir(project, { recursive: true });

  const projectLink = path.join(securityRoot, "project-link");
  await symlink(project, projectLink);
  const linkedRoot = capture(securityRoot);
  assert.equal(
    await main(["init", "--root", "project-link", "--json"], linkedRoot.io),
    EXIT_CODES.FAILED,
  );
  assert.equal(JSON.parse(linkedRoot.stderr()).error.code, "PATH_TRAVERSAL");

  const outsideTrestle = path.join(securityRoot, "outside-trestle");
  await mkdir(outsideTrestle, { recursive: true });
  await symlink(outsideTrestle, path.join(project, ".trestle"));
  const linkedTrestle = capture(project);
  assert.equal(await main(["init", "--json"], linkedTrestle.io), EXIT_CODES.FAILED);
  assert.equal(JSON.parse(linkedTrestle.stderr()).error.code, "PATH_TRAVERSAL");

  await rm(path.join(project, ".trestle"), { force: true });
  await mkdir(path.join(project, ".trestle"), { recursive: true });
  await mkdir(path.join(project, ".github"), { recursive: true });
  const outsideAgents = path.join(securityRoot, "outside-agents");
  await mkdir(outsideAgents, { recursive: true });
  await symlink(outsideAgents, path.join(project, ".github", "agents"));
  const linkedAgents = capture(project);
  assert.equal(await main(["init", "--json"], linkedAgents.io), EXIT_CODES.FAILED);
  assert.equal(JSON.parse(linkedAgents.stderr()).error.code, "PATH_TRAVERSAL");

  await rm(securityRoot, { recursive: true, force: true });
});

test("init --force rejects symlinked target files and leaves outside files unchanged", async () => {
  const { main } = await import("../../src/cli/main.mjs");
  const securityRoot = path.join(scratchRoot, "init-force-symlink");
  const project = path.join(securityRoot, "project");
  const outside = path.join(securityRoot, "outside");
  await rm(securityRoot, { recursive: true, force: true });
  await mkdir(path.join(project, ".trestle"), { recursive: true });
  await mkdir(path.join(project, ".github", "agents"), { recursive: true });
  await mkdir(outside, { recursive: true });

  const outsideConfig = path.join(outside, "config.json");
  const outsideAgent = path.join(outside, "example-builder.agent.md");
  await writeFile(outsideConfig, "outside-config\n");
  await writeFile(outsideAgent, "outside-agent\n");
  await symlink(outsideConfig, path.join(project, ".trestle", "config.json"));
  await symlink(outsideAgent, path.join(project, ".github", "agents", "example-builder.agent.md"));

  const forced = capture(project);
  assert.equal(await main(["init", "--force", "--json"], forced.io), EXIT_CODES.FAILED);
  assert.equal(JSON.parse(forced.stderr()).error.code, "PATH_TRAVERSAL");
  assert.equal(await readFile(outsideConfig, "utf8"), "outside-config\n");
  assert.equal(await readFile(outsideAgent, "utf8"), "outside-agent\n");

  await rm(securityRoot, { recursive: true, force: true });
});

test("CLI preserves non-empty equals values in inline options", async () => {
  const testRoot = path.join(scratchRoot, "cli-equals-test");
  await rm(testRoot, { recursive: true, force: true });
  await mkdir(testRoot, { recursive: true });

  const io = capture(testRoot);
  const { main } = await import("../../src/cli/main.mjs");
  const exitCode = await main(["dashboard", "--data=missing=file=name", "--json"], io.io);
  assert.equal(exitCode, EXIT_CODES.FAILED);
  const failure = JSON.parse(io.stderr());
  assert.equal(failure.error.code, "ENOENT");
  assert.match(failure.error.message, /missing=file=name/);

  await rm(testRoot, { recursive: true, force: true });
});

test("CLI rejects empty values for non-boolean options", async () => {
  const io = capture();
  const { main } = await import("../../src/cli/main.mjs");
  const exitCode = await main(["dashboard", "--data=", "--json"], io.io);
  assert.equal(exitCode, EXIT_CODES.USAGE);
  const failure = JSON.parse(io.stderr());
  assert.equal(failure.error.code, "USAGE");
  assert.match(failure.error.message, /--data requires a non-empty value/);
});

test("review requires --timeout-ms to be strictly positive", async () => {
  const io = capture();
  const { main } = await import("../../src/cli/main.mjs");
  const exitCode = await main([
    "review",
    "--base", "main",
    "--head", "task",
    "--producer", "builder",
    "--reviewer", "code-review",
    "--timeout-ms", "0",
    "--json",
  ], io.io);
  assert.equal(exitCode, EXIT_CODES.USAGE);
  const failure = JSON.parse(io.stderr());
  assert.equal(failure.error.code, "USAGE");
  assert.match(failure.error.message, /--timeout-ms must be a positive integer/);
});

test("state-lock and state-unlock expose the fail-closed stale-recovery contract", async () => {
  const stateRoot = path.join(scratchRoot, "cli-state-lock");
  const staleLock = path.join(
    stateRoot,
    ".trestle/state/workstreams/main/namespaces/values/one.json.lock",
  );
  await rm(stateRoot, { recursive: true, force: true });
  await mkdir(dirname(staleLock), { recursive: true });
  await writeFile(staleLock, `${JSON.stringify({
    token: "stale-token",
    pid: 424242,
    host: "remote-host",
    epoch: Date.now() - 60_000,
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  })}\n`);

  const status = capture(stateRoot);
  assert.equal(await runCli([
    "state-lock",
    "--workstream", "main",
    "--namespace", "values",
    "--key", "one",
    "--json",
  ], status.io), EXIT_CODES.SUCCESS);
  const inspected = JSON.parse(status.stdout());
  assert.equal(inspected.lock.status, "operator-recovery-required");

  const unlock = capture(stateRoot);
  assert.equal(await runCli([
    "state-unlock",
    "--workstream", "main",
    "--namespace", "values",
    "--key", "one",
    "--expected-token", "stale-token",
    "--expected-inode", String(inspected.lock.ino),
    "--json",
  ], unlock.io), EXIT_CODES.SUCCESS);
  assert.equal(JSON.parse(unlock.stdout()).unlocked, true);

  await writeFile(staleLock, `${JSON.stringify({
    token: "live-token",
    pid: process.pid,
    host: hostname(),
    epoch: Date.now() - 60_000,
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  })}\n`);
  const denied = capture(stateRoot);
  assert.equal(await main([
    "state-unlock",
    "--workstream", "main",
    "--namespace", "values",
    "--key", "one",
    "--expected-token", "live-token",
    "--json",
  ], denied.io), EXIT_CODES.BLOCKED);
  assert.equal(JSON.parse(denied.stderr()).error.code, "LOCK_NOT_STALE");

  await rm(stateRoot, { recursive: true, force: true });
});

test("state-lock emits an executable tokenless hint that recovers a malformed crash-window lock", async () => {
  const stateRoot = path.join(scratchRoot, "cli-state-malformed");
  const malformedLock = path.join(
    stateRoot,
    ".trestle/state/workstreams/main/namespaces/values/one.json.lock",
  );
  await rm(stateRoot, { recursive: true, force: true });
  await mkdir(dirname(malformedLock), { recursive: true });
  // Zero-length file left when a crash interrupts lock creation.
  await writeFile(malformedLock, "");

  const status = capture(stateRoot);
  assert.equal(await runCli([
    "state-lock", "--workstream", "main", "--namespace", "values", "--key", "one", "--json",
  ], status.io), EXIT_CODES.SUCCESS);
  const inspected = JSON.parse(status.stdout());
  assert.equal(inspected.lock.status, "operator-recovery-required");
  assert.equal(inspected.lock.malformed, true);
  assert.equal(inspected.unlock.authorization, "expected-identity");
  assert.equal(inspected.unlock.arguments.expectedToken, undefined);
  assert.equal(inspected.unlock.arguments.expectedInode, inspected.lock.ino);
  assert.equal(inspected.unlock.arguments.expectedDevice, inspected.lock.dev);
  assert.match(inspected.unlock.cli, /^agent-trestle state-unlock /);
  assert.match(inspected.unlock.cli, new RegExp(`--root ${stateRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
  assert.match(inspected.unlock.cli, /--workstream main /);
  assert.match(inspected.unlock.cli, /--expected-inode \d+ --expected-device \d+$/);
  assert.doesNotMatch(inspected.unlock.cli, /--expected-token/);

  // Execute the emitted CLI hint verbatim (argv derived from the exact string).
  const hintArgv = inspected.unlock.cli.split(" ").slice(1).concat("--json");
  const differentCwd = path.join(scratchRoot, "cli-state-unlock-other-cwd");
  await mkdir(differentCwd, { recursive: true });
  const unlock = capture(differentCwd);
  assert.equal(await runCli(hintArgv, unlock.io), EXIT_CODES.SUCCESS);
  assert.equal(JSON.parse(unlock.stdout()).unlocked, true);
  await assert.rejects(() => readFile(malformedLock, "utf8"), (error) => error.code === "ENOENT");

  // A subsequent write acquires a fresh lock and succeeds.
  const store = library.state.createTrestleStateStore({
    projectStateRoot: path.join(stateRoot, ".trestle/state/project"),
    workstreamStateRoot: path.join(stateRoot, ".trestle/state/workstreams/main"),
    configRoot: path.join(stateRoot, ".trestle"),
    workstreamId: "main",
    schemas: { values: { type: "object", required: ["value"] } },
  });
  await store.write({ namespace: "values", key: "one", value: { value: 7 } });
  assert.deepEqual(await store.read({ namespace: "values", key: "one" }), { value: 7 });

  await rm(stateRoot, { recursive: true, force: true });
});

test("state-unlock enforces token-or-identity option requirements and refuses live locks tokenlessly", async () => {
  const stateRoot = path.join(scratchRoot, "cli-state-unlock-guards");
  const lockFile = path.join(
    stateRoot,
    ".trestle/state/workstreams/main/namespaces/values/one.json.lock",
  );
  await rm(stateRoot, { recursive: true, force: true });
  await mkdir(dirname(lockFile), { recursive: true });

  // Neither a token nor a full inode+device identity is a usage error.
  await writeFile(lockFile, "");
  const noAuth = capture(stateRoot);
  assert.equal(await main([
    "state-unlock", "--workstream", "main", "--namespace", "values", "--key", "one",
    "--expected-inode", "123", "--json",
  ], noAuth.io), EXIT_CODES.USAGE);
  assert.match(JSON.parse(noAuth.stderr()).error.message, /--expected-token is required unless/);

  // A valid live lock must never be cleared tokenlessly by identity alone.
  await writeFile(lockFile, `${JSON.stringify({
    token: "live-token", pid: process.pid, host: hostname(),
    epoch: Date.now() - 60_000, acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  })}\n`);
  const inspect = capture(stateRoot);
  assert.equal(await runCli([
    "state-lock", "--workstream", "main", "--namespace", "values", "--key", "one", "--json",
  ], inspect.io), EXIT_CODES.SUCCESS);
  const live = JSON.parse(inspect.stdout());
  assert.equal(live.lock.status, "live");

  const denied = capture(stateRoot);
  assert.equal(await main([
    "state-unlock", "--workstream", "main", "--namespace", "values", "--key", "one",
    "--expected-inode", String(live.lock.ino), "--expected-device", String(live.lock.dev), "--json",
  ], denied.io), EXIT_CODES.BLOCKED);
  assert.equal(JSON.parse(denied.stderr()).error.code, "LOCK_TOKEN_REQUIRED");
  assert.match(await readFile(lockFile, "utf8"), /live-token/);

  await rm(stateRoot, { recursive: true, force: true });
});

test("init rejects unknown options such as --forcce before creating files", async () => {
  const { main } = await import("../../src/cli/main.mjs");
  const testRoot = path.join(scratchRoot, "cli-unknown-option");
  await rm(testRoot, { recursive: true, force: true });
  await mkdir(testRoot, { recursive: true });

  const io = capture(testRoot);
  const exitCode = await main(["init", "--forcce", "--json"], io.io);
  assert.equal(exitCode, EXIT_CODES.USAGE);
  const failure = JSON.parse(io.stderr());
  assert.equal(failure.error.code, "USAGE");
  assert.match(failure.error.message, /Unknown option --forcce/);
  await assert.rejects(
    () => readFile(path.join(testRoot, ".trestle/config.json"), "utf8"),
    (error) => error.code === "ENOENT",
  );
  await assert.rejects(
    () => readFile(path.join(testRoot, ".github/agents/example-builder.agent.md"), "utf8"),
    (error) => error.code === "ENOENT",
  );

  await rm(testRoot, { recursive: true, force: true });
});

test("value options reject a following flag as their value (--root --json)", async () => {
  const { main } = await import("../../src/cli/main.mjs");
  const testRoot = path.join(scratchRoot, "cli-root-json");
  await rm(testRoot, { recursive: true, force: true });
  await mkdir(testRoot, { recursive: true });

  const io = capture(testRoot);
  const exitCode = await main(["init", "--root", "--json"], io.io);
  assert.equal(exitCode, EXIT_CODES.USAGE);
  const failure = JSON.parse(io.stderr());
  assert.equal(failure.error.code, "USAGE");
  assert.match(failure.error.message, /--root requires a non-empty value/);
  await assert.rejects(
    () => readFile(path.join(testRoot, ".trestle/config.json"), "utf8"),
    (error) => error.code === "ENOENT",
  );

  await rm(testRoot, { recursive: true, force: true });
});

test("dispatch preserves repeatable --skill values", async () => {
  const { main } = await import("../../src/cli/main.mjs");
  const testRoot = path.join(scratchRoot, "cli-repeatable-skill");
  await rm(testRoot, { recursive: true, force: true });
  await mkdir(testRoot, { recursive: true });

  // Fail closed on a missing required option after accepting repeated --skill,
  // proving the allowlist accepts the repeat without side effects.
  const io = capture(testRoot);
  const exitCode = await main([
    "dispatch",
    "--skill", "alpha",
    "--skill", "beta",
    "--project", "example-project",
    "--workstream", "main",
    "--role", "builder",
    "--json",
  ], io.io);
  assert.equal(exitCode, EXIT_CODES.USAGE);
  const failure = JSON.parse(io.stderr());
  assert.equal(failure.error.code, "USAGE");
  assert.match(failure.error.message, /Specify exactly one of --prompt or --prompt-file/);

  await rm(testRoot, { recursive: true, force: true });
});
