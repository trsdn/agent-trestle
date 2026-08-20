import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const packageRoot = path.resolve(".");
const fixtureRoot = path.resolve("test/.work/package-install");
const packRoot = path.join(fixtureRoot, "pack");
const installRoot = path.join(fixtureRoot, "consumer");

test.after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: path.join(fixtureRoot, "npm-cache") },
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

test("npm pack installs a clean CLI with public exports and bundled templates", async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(packRoot, { recursive: true });
  const sourcePackage = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  run("npm", ["pack", "--silent", "--pack-destination", packRoot]);
  const tarball = path.join(packRoot, (await readdir(packRoot)).find((name) => name.endsWith(".tgz")));

  await mkdir(installRoot, { recursive: true });
  run("npm", ["init", "-y", "--silent"], { cwd: installRoot });
  run("npm", ["install", "--silent", "--ignore-scripts", tarball], { cwd: installRoot });

  const binDirectory = path.join(installRoot, "node_modules", ".bin");
  const bin = path.join(
    binDirectory,
    process.platform === "win32" ? "agent-trestle.cmd" : "agent-trestle",
  );
  assert.equal(run(bin, ["--version"], { cwd: installRoot }).trim(), sourcePackage.version);
  await assert.rejects(
    readFile(path.join(binDirectory, process.platform === "win32" ? "trestle.cmd" : "trestle")),
    (error) => error.code === "ENOENT",
  );
  const exportsOutput = run(process.execPath, [
    "--input-type=module",
    "-e",
    "import('agent-trestle').then(m => console.log(Object.keys(m).sort().join(',')))",
  ], { cwd: installRoot });
  assert.match(exportsOutput, /audit,config,copilot,dashboard,dispatch,ownership,review,scheduler,state,worktrees/);

  run(bin, ["init", "--json"], { cwd: installRoot });
  const config = JSON.parse(await readFile(path.join(installRoot, ".trestle", "config.json"), "utf8"));
  assert.equal(config.permissions.allowAllTools, false);
  const installedPackage = JSON.parse(await readFile(
    path.join(installRoot, "node_modules", "agent-trestle", "package.json"),
    "utf8",
  ));
  assert.equal(installedPackage.private, undefined);
  assert.deepEqual(installedPackage.bin, {
    "agent-trestle": "./src/cli/agent-trestle.mjs",
  });
});
