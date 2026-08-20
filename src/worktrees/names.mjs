import { createHash } from "node:crypto";

export function safeWorktreeName(value, { prefix = "trestle", maxLength = 63 } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("worktree name input must be a non-empty string");
  }
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, Math.max(1, maxLength - prefix.length - hash.length - 2))
    .replace(/-+$/g, "") || "work";
  return `${prefix}-${slug}-${hash}`;
}

export function safeBranchName(value) {
  return `trestle/${safeWorktreeName(value, { prefix: "task" })}`;
}

