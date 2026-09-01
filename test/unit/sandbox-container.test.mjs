import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContainerCommand,
  COPILOT_HOME_MOUNT,
  describeSandbox,
  normalizeMountSource,
  normalizeSandbox,
  SandboxConfigError,
  WORKDIR,
} from "../../src/sandbox/container.mjs";
import { runCopilot } from "../../src/copilot/process-adapter.mjs";

const IMAGE = "ghcr.io/example/copilot:1";
// runCopilot resolves the mount source against the real platform, so these
// cases need a path that is genuinely absolute on the host running the suite.
const HOST_CWD = process.platform === "win32" ? "C:\\srv\\work" : "/srv/work";

function sandbox(overrides = {}) {
  return normalizeSandbox({ image: IMAGE, ...overrides }, "sandbox", { platform: "linux" });
}

function build(overrides = {}, options = {}) {
  return buildContainerCommand({
    binary: "copilot",
    args: ["--agent", "builder", "-p", "do the thing"],
    cwd: "/srv/work",
    sandbox: sandbox(overrides),
    platform: "linux",
    getuid: () => 1000,
    getgid: () => 1000,
    ...options,
  });
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

test("the sandbox denies network and drops privileges by default", () => {
  const { binary, args } = build();
  assert.equal(binary, "docker");
  assert.equal(valueAfter(args, "--network"), "none");
  assert.equal(valueAfter(args, "--cap-drop"), "ALL");
  assert.equal(valueAfter(args, "--security-opt"), "no-new-privileges");
  assert.equal(valueAfter(args, "--workdir"), WORKDIR);
  assert.equal(valueAfter(args, "--volume"), `/srv/work:${WORKDIR}`);
  assert.ok(args.includes("--rm"));
});

test("only the worktree is mounted", () => {
  const { args } = build();
  const mounts = args.filter((arg, index) => args[index - 1] === "--volume");
  assert.deepEqual(mounts, [`/srv/work:${WORKDIR}`]);
});

test("the original command is appended last and unchanged", () => {
  const { args } = build();
  const imageIndex = args.indexOf(IMAGE);
  assert.deepEqual(
    args.slice(imageIndex),
    [IMAGE, "copilot", "--agent", "builder", "-p", "do the thing"],
  );
  // The trailing "-p <prompt>" pair must stay in final position so positional
  // prompt redaction in the process adapter keeps masking the right element.
  assert.equal(args.at(-2), "-p");
  assert.equal(args.at(-1), "do the thing");
});

test("the host user is mapped on POSIX so outputs are not root-owned", () => {
  assert.equal(valueAfter(build().args, "--user"), "1000:1000");
});

test("no user mapping is attempted on Windows", () => {
  const { args } = build({}, {
    cwd: "C:\\work\\repo",
    platform: "win32",
    getuid: undefined,
    getgid: undefined,
  });
  assert.equal(args.includes("--user"), false);
  assert.equal(valueAfter(args, "--volume"), `C:\\work\\repo:${WORKDIR}`);
});

test("environment is passed by name so secrets never reach argv", () => {
  const { args } = build({ env: ["HTTPS_PROXY", "HTTPS_PROXY"] });
  const passed = args.filter((arg, index) => args[index - 1] === "--env");
  assert.deepEqual(passed, ["HTTPS_PROXY"]);
  assert.equal(args.some((arg) => arg.includes("=")), false);
});

test("a mounted Copilot home is read-only", () => {
  const { args } = build({ copilotHome: "/home/dev/.copilot" });
  assert.ok(args.includes(`/home/dev/.copilot:${COPILOT_HOME_MOUNT}:ro`));
  assert.equal(valueAfter(args, "--env"), `COPILOT_HOME=${COPILOT_HOME_MOUNT}`);
});

test("resource bounds are emitted only when declared", () => {
  assert.equal(build().args.includes("--memory"), false);
  const { args } = build({ memory: "2g", cpus: "1.5" });
  assert.equal(valueAfter(args, "--memory"), "2g");
  assert.equal(valueAfter(args, "--cpus"), "1.5");
  assert.equal(valueAfter(args, "--pids-limit"), "512");
});

test("a mount source cannot smuggle extra volume fields", () => {
  for (const candidate of ["/srv/work:/etc", "/srv/work:ro", "relative/path", "/srv/\nwork"]) {
    assert.throws(
      () => normalizeMountSource(candidate, { platform: "linux" }),
      SandboxConfigError,
      `expected ${candidate} to be rejected`,
    );
  }
});

test("a Windows drive letter is the only colon allowed", () => {
  assert.equal(normalizeMountSource("C:\\work", { platform: "win32" }), "C:\\work");
  assert.throws(
    () => normalizeMountSource("C:\\work:ro", { platform: "win32" }),
    SandboxConfigError,
  );
  assert.throws(
    () => normalizeMountSource("\\\\server\\share", { platform: "win32" }),
    SandboxConfigError,
  );
});

test("operands that would be parsed as runtime flags are rejected", () => {
  assert.throws(() => sandbox({ image: "-v/etc:/etc" }), SandboxConfigError);
  assert.throws(() => sandbox({ image: "" }), SandboxConfigError);
});

test("the sandbox declaration is a closed schema", () => {
  assert.throws(() => sandbox({ privileged: true }), /unknown keys: privileged/);
});

test("host networking cannot be requested", () => {
  assert.throws(() => sandbox({ network: "host" }), /network must be one of none, bridge/);
});

test("an unsupported runtime is rejected", () => {
  assert.throws(() => sandbox({ runtime: "chroot" }), /runtime must be one of docker, podman/);
});

test("pidsLimit must be a positive integer", () => {
  assert.throws(() => sandbox({ pidsLimit: 0 }), SandboxConfigError);
  assert.throws(() => sandbox({ pidsLimit: 1.5 }), SandboxConfigError);
});

test("normalizing an already-normalized sandbox is stable", () => {
  const once = sandbox({ memory: "2g", env: ["HTTP_PROXY"], copilotHome: "/home/dev/.copilot" });
  assert.deepEqual(normalizeSandbox(once, "sandbox", { platform: "linux" }), once);
});

test("audit metadata carries no environment values", () => {
  const described = describeSandbox(sandbox({ env: ["HTTPS_PROXY"], copilotHome: "/home/dev/x" }));
  assert.deepEqual(described.env, ["HTTPS_PROXY"]);
  assert.equal(described.copilotHomeMounted, true);
  assert.equal(Object.hasOwn(described, "copilotHome"), false);
});

test("runCopilot leaves the invocation untouched when no sandbox is declared", async () => {
  let seen;
  const result = await runCopilot({
    prompt: "secret prompt",
    agent: "builder",
    cwd: HOST_CWD,
    binary: "copilot",
    runner: async (spec) => {
      seen = spec;
      return {
        exitCode: 0, signal: null, error: undefined, timedOut: false,
        aborted: false, outputExceeded: null, stdout: "", stderr: "",
      };
    },
  });
  assert.equal(seen.binary, "copilot");
  assert.equal(seen.args[0], "--agent");
  assert.equal(result.command, "copilot");
  assert.equal(Object.hasOwn(result, "sandbox"), false);
});

test("runCopilot routes through the runtime and still redacts the prompt", async () => {
  let seen;
  const result = await runCopilot({
    prompt: "secret prompt",
    agent: "builder",
    cwd: HOST_CWD,
    binary: "copilot",
    sandbox: { image: IMAGE },
    runner: async (spec) => {
      seen = spec;
      return {
        exitCode: 0, signal: null, error: undefined, timedOut: false,
        aborted: false, outputExceeded: null,
        stdout: "leaked secret prompt", stderr: "",
      };
    },
  });
  assert.equal(seen.binary, "docker");
  assert.equal(seen.args[0], "run");
  assert.ok(seen.args.includes(IMAGE));
  // The real prompt still reaches the container...
  assert.equal(seen.args.at(-1), "secret prompt");
  // ...but never survives into the reported result.
  assert.equal(result.command, "docker");
  assert.equal(result.args.at(-1), "[REDACTED]");
  assert.equal(result.stdout.includes("secret prompt"), false);
  assert.equal(result.sandbox.image, IMAGE);
  assert.equal(result.sandbox.network, "none");
});

test("runCopilot rejects an invalid sandbox before spawning anything", async () => {
  let spawned = false;
  await assert.rejects(
    () => runCopilot({
      prompt: "p",
      agent: "builder",
      cwd: HOST_CWD,
      sandbox: { image: "-v/etc:/etc" },
      runner: async () => { spawned = true; },
    }),
    SandboxConfigError,
  );
  assert.equal(spawned, false);
});
