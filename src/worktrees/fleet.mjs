import path from "node:path";
import { safeBranchName, safeWorktreeName } from "./names.mjs";
import {
  assertSecurelyHeldDirectory,
  PathSecurityError,
  pinDirectory,
  verifyDescendant,
  verifyPinnedDirectory,
} from "../security/path-security.mjs";

function requireAbsolute(label, value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function assertGitAdapter(git) {
  if (!git || typeof git.run !== "function") {
    throw new TypeError("git adapter must implement run({ repoRoot, args })");
  }
}

function requireSafeRef(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("-") ||
    /[\s~^:?*[\]\\]/.test(value) ||
    value.includes("..") ||
    value.includes("@{")
  ) {
    throw new Error(`${label} is not a safe git ref`);
  }
}

export function createWorktreeFleet({ repoRoot, worktreeRoot, git, security = {} } = {}) {
  const root = requireAbsolute("repoRoot", repoRoot);
  const fleetRoot = requireAbsolute("worktreeRoot", worktreeRoot);
  assertGitAdapter(git);
  let pins;
  let pinsPromise;

  async function ensurePins() {
    if (pins) {
      await verifyPinnedDirectory(pins.repo);
      await verifyPinnedDirectory(pins.fleet);
      return pins;
    }
    if (!pinsPromise) {
      pinsPromise = Promise.all([
        pinDirectory(root),
        pinDirectory(fleetRoot, { create: true }),
      ]).then(([repo, fleet]) => {
        pins = { repo, fleet };
        return pins;
      });
    }
    return pinsPromise;
  }

  // Git resolves the paths we hand it on its own and cannot be pinned to a Node
  // directory handle portably, so a pre/post `verifyDescendant` can only *detect*
  // a root swap after Git has already written through it. Instead, refuse to
  // invoke Git at all unless the relevant root is securely held — i.e. no
  // untrusted user can swap or write a component of its path. This makes the
  // escaped write impossible rather than merely observable, and fails closed on
  // hosts (or platforms) where that guarantee cannot be proven.
  async function assertSecurelyHeld(pin, operation) {
    try {
      await assertSecurelyHeldDirectory(pin.path, security);
    } catch (error) {
      if (
        error instanceof PathSecurityError
        && (error.code === "INSECURE_CONTAINMENT" || error.code === "UNSUPPORTED_PLATFORM")
      ) {
        throw new PathSecurityError(
          `Refusing automatic worktree ${operation}: ${pin.path} cannot be securely held `
            + `(${error.message}). Relocate it under a directory owned by this user and not `
            + `writable by others so Git cannot be redirected outside it.`,
          "INSECURE_CONTAINMENT",
        );
      }
      throw error;
    }
  }

  async function create({ id, startPoint = "HEAD" }) {
    requireSafeRef(startPoint, "startPoint");
    const roots = await ensurePins();
    await assertSecurelyHeld(roots.repo, "creation");
    await assertSecurelyHeld(roots.fleet, "creation");
    const name = safeWorktreeName(id);
    const branch = safeBranchName(id);
    const worktreePath = path.join(fleetRoot, name);
    await verifyDescendant(roots.fleet, worktreePath, { allowMissing: true });
    await git.run({
      repoRoot: roots.repo.path,
      args: ["worktree", "add", "-b", branch, worktreePath, startPoint],
    });
    await verifyDescendant(roots.fleet, worktreePath, { allowMissing: false });
    return { id, name, branch, path: worktreePath, status: "active" };
  }

  async function remove(worktree, { force = false, outcome } = {}) {
    if (outcome === "failed") {
      return { ...worktree, status: "retained", retainedReason: "failed" };
    }
    const roots = await ensurePins();
    await assertSecurelyHeld(roots.repo, "removal");
    await assertSecurelyHeld(roots.fleet, "removal");
    const resolved = path.resolve(worktree.path);
    await verifyDescendant(roots.fleet, resolved, { allowMissing: false });
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(resolved);
    await git.run({ repoRoot: roots.repo.path, args });
    return { ...worktree, status: "removed" };
  }

  async function prune() {
    const roots = await ensurePins();
    await assertSecurelyHeld(roots.repo, "prune");
    await git.run({ repoRoot: roots.repo.path, args: ["worktree", "prune"] });
  }

  return Object.freeze({ repoRoot: root, worktreeRoot: fleetRoot, create, remove, prune });
}
