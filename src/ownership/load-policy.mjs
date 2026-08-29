import path from "node:path";
import { pinDirectory, readVerifiedFile, releasePin } from "../security/path-security.mjs";
import { createOwnershipPolicy } from "./policy.mjs";

export const OWNERSHIP_VERSION = 1;

/** True when `target` resolves to a path inside `root`. */
function withinRoot(root, target) {
  const relative = path.relative(path.resolve(root), target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const KEYS = ["version", "owners", "defaultOwner", "allowUnowned", "pathStyle"];

export class OwnershipPolicyError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "OwnershipPolicyError";
    this.code = "INVALID_OWNERSHIP_POLICY";
  }
}

export function validateOwnershipDocument(input) {
  if (input === null || Array.isArray(input) || typeof input !== "object") {
    throw new OwnershipPolicyError("ownership policy must be an object");
  }
  const unknown = Object.keys(input).find((key) => !KEYS.includes(key));
  if (unknown) {
    throw new OwnershipPolicyError(`ownership policy contains unknown key: ${unknown}`);
  }
  if (input.version !== OWNERSHIP_VERSION) {
    throw new OwnershipPolicyError(`ownership policy version must be ${OWNERSHIP_VERSION}`);
  }
  if (
    input.owners === null
    || Array.isArray(input.owners)
    || typeof input.owners !== "object"
    || Object.keys(input.owners).length === 0
  ) {
    throw new OwnershipPolicyError("ownership policy owners must be a non-empty object");
  }
  for (const [owner, patterns] of Object.entries(input.owners)) {
    if (owner.trim() === "") {
      throw new OwnershipPolicyError("ownership policy owner IDs must be non-empty");
    }
    if (
      !Array.isArray(patterns)
      || patterns.length === 0
      || patterns.some((pattern) => typeof pattern !== "string" || pattern.trim() === "")
    ) {
      throw new OwnershipPolicyError(
        `ownership patterns for ${owner} must be a non-empty array of non-empty strings`,
      );
    }
  }
  if (
    Object.hasOwn(input, "defaultOwner")
    && input.defaultOwner !== null
    && (typeof input.defaultOwner !== "string" || input.defaultOwner.trim() === "")
  ) {
    throw new OwnershipPolicyError("ownership policy defaultOwner must be a non-empty string or null");
  }
  if (Object.hasOwn(input, "allowUnowned") && typeof input.allowUnowned !== "boolean") {
    throw new OwnershipPolicyError("ownership policy allowUnowned must be a boolean");
  }
  if (Object.hasOwn(input, "pathStyle") && !["posix", "win32"].includes(input.pathStyle)) {
    throw new OwnershipPolicyError('ownership policy pathStyle must be "posix" or "win32"');
  }

  // Compiling here means an unsafe glob (an absolute or parent-escaping path)
  // is rejected when the document is read, not when a merge is already underway.
  return createOwnershipPolicy({
    owners: input.owners,
    defaultOwner: input.defaultOwner ?? null,
    allowUnowned: input.allowUnowned ?? false,
    pathStyle: input.pathStyle ?? "posix",
  });
}

/**
 * Reads an ownership policy through the same pinned-directory checks as project
 * configuration, so a policy swapped or symlinked mid-read fails closed rather
 * than silently widening what an actor may merge.
 *
 * Keeping the document outside the repository is the recommended layout: it is
 * the authority that constrains a semi-trusted agent, so it should not live in
 * a directory that agent can write.
 */
export async function loadOwnershipPolicy(repoRoot, policyPath, {
  pinDirectoryImpl = pinDirectory,
  readVerifiedFileImpl = readVerifiedFile,
} = {}) {
  if (typeof repoRoot !== "string" || repoRoot.trim() === "") {
    throw new OwnershipPolicyError("repoRoot must be an explicit path");
  }
  if (typeof policyPath !== "string" || policyPath.trim() === "") {
    throw new OwnershipPolicyError("ownership policy path must be explicit");
  }
  const filename = path.resolve(repoRoot, policyPath);
  // Anchor the pin on whichever directory actually holds the policy. Confining
  // it to repoRoot left the operator no supported way to keep the document
  // outside the tree the producer agent writes to, so a compromised agent could
  // rewrite the very authorization meant to constrain it. An out-of-repo policy
  // gets the same pinned, symlink-safe read, just anchored at its own directory.
  const anchor = withinRoot(repoRoot, filename) ? repoRoot : path.dirname(filename);
  const pin = await pinDirectoryImpl(anchor);
  let parsed;
  try {
    parsed = JSON.parse(await readVerifiedFileImpl(pin, filename));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new OwnershipPolicyError(`Invalid JSON in ${filename}: ${error.message}`);
    }
    throw error;
  } finally {
    await releasePin(pin);
  }
  return validateOwnershipDocument(parsed);
}
