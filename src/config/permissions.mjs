export const DEFAULT_PERMISSIONS = Object.freeze({
  allowAllTools: false,
  allowAllPaths: false,
  allowAllUrls: false,
  nonInteractive: false,
  autoMerge: false,
});

const PERMISSION_KEYS = Object.keys(DEFAULT_PERMISSIONS);

export function normalizePermissions(value = {}, context = "permissions") {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${context} must be an object`);
  }

  const unknown = Object.keys(value).filter((key) => !PERMISSION_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(`${context} contains unknown keys: ${unknown.sort().join(", ")}`);
  }

  const normalized = { ...DEFAULT_PERMISSIONS };
  for (const key of PERMISSION_KEYS) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new TypeError(`${context}.${key} must be a boolean`);
    }
    if (value[key] !== undefined) normalized[key] = value[key];
  }
  return normalized;
}

export function mergePermissions(...layers) {
  const merged = { ...DEFAULT_PERMISSIONS };
  for (const [index, layer] of layers.entries()) {
    if (layer === undefined) continue;
    const normalized = normalizePermissions(layer, `permissions layer ${index + 1}`);
    for (const key of Object.keys(layer)) merged[key] = normalized[key];
  }
  return merged;
}

export function copilotPermissionArgs(permissions = {}) {
  const effective = normalizePermissions(permissions);
  const args = [];
  if (effective.allowAllTools) args.push("--allow-all-tools");
  if (effective.allowAllPaths) args.push("--allow-all-paths");
  if (effective.allowAllUrls) args.push("--allow-all-urls");
  if (effective.nonInteractive) args.push("--no-ask-user");
  return args;
}

export function assertAutoMergeAllowed(permissions = {}) {
  const effective = normalizePermissions(permissions);
  if (!effective.autoMerge) {
    throw new Error("Automatic merge requires permissions.autoMerge to be explicitly enabled");
  }
  return effective;
}
