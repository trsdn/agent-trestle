import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

const scratchBase = path.resolve("test/.work/.scratch");
const host = hostname().replace(/[^a-zA-Z0-9.-]/g, "_");
const createdRoots = new Set();
let cleanupRegistered = false;
let stalePurgeStarted = null;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

// Purging is best effort by definition: other workers create, mark and delete
// their own containers concurrently, so any entry observed here may vanish
// mid-inspection. A cleanup pass must never be able to fail a test run, so
// every per-entry error is swallowed and the pass itself never rejects.
async function purgeStaleScratchRoots() {
  try {
    await mkdir(scratchBase, { recursive: true, mode: 0o700 });
    const entries = await readdir(scratchBase, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const root = path.join(scratchBase, entry.name);
      try {
        try {
          const marker = JSON.parse(await readFile(path.join(root, ".owner.json"), "utf8"));
          if (marker.host === host && processAlive(marker.pid)) return;
        } catch {
          // No readable marker yet. A container is created before its marker is
          // written, so a young directory may belong to a live worker mid-setup
          // and must not be reclaimed.
          const { mtimeMs } = await lstat(root);
          if (Date.now() - mtimeMs < 60 * 60 * 1_000) return;
        }
        await rm(root, { recursive: true, force: true });
      } catch {
        // Raced with the owning worker; leave it for a later pass.
      }
    }));
  } catch {
    // A scratch base that cannot be listed is not a test failure.
  }
}

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = () => {
    for (const root of createdRoots) {
      rmSync(root, { recursive: true, force: true });
    }
  };

  process.once("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      cleanup();
      process.kill(process.pid, signal);
    });
  }
}

export async function makeScratchRoot(label) {
  stalePurgeStarted ??= purgeStaleScratchRoots();
  await stalePurgeStarted;
  registerCleanup();

  const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, "-");
  const container = await mkdtemp(path.join(
    scratchBase,
    `${safeLabel}-${host}-${process.pid}-${randomBytes(6).toString("hex")}-`,
  ));
  await writeFile(path.join(container, ".owner.json"), `${JSON.stringify({
    host,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })}\n`);
  createdRoots.add(container);
  const root = path.join(container, "root");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}
