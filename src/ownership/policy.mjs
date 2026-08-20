import path from "node:path";

function resolvePathStyle(pathStyle = "posix", platform) {
  const value = platform ?? pathStyle;
  if (value !== "posix" && value !== "win32") {
    throw new TypeError('pathStyle/platform must be "posix" or "win32"');
  }
  return value;
}

function normalizePosix(candidate) {
  const value = candidate.replace(/^\.\/+/, "");
  if (
    value === "" ||
    value.startsWith("/") ||
    value === ".." ||
    value.startsWith("../") ||
    value.includes("/../")
  ) {
    throw new Error(`unsafe repository-relative path: ${candidate}`);
  }
  return path.posix.normalize(value);
}

function normalizeWin32(candidate) {
  const value = candidate.replace(/^\.[\\/]+/, "");
  if (
    value === "" ||
    path.win32.isAbsolute(value) ||
    value.includes(":") ||
    /(^|[\\/])\.\.([\\/]|$)/.test(value)
  ) {
    throw new Error(`unsafe repository-relative path: ${candidate}`);
  }
  return path.win32.normalize(value).replaceAll("\\", "/");
}

function normalize(candidate, pathStyle = "posix") {
  if (typeof candidate !== "string") {
    throw new TypeError("repository-relative path must be a string");
  }
  return pathStyle === "win32"
    ? normalizeWin32(candidate)
    : normalizePosix(candidate);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function compileGlob(pattern, { pathStyle = "posix" } = {}) {
  const normalized = normalize(pattern, pathStyle);
  let source = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === "*" && normalized[i + 1] === "*") {
      if (normalized[i + 2] === "/") {
        source += "(?:[\\s\\S]*/)?";
        i += 2;
      } else {
        source += "[\\s\\S]*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

export function createOwnershipPolicy({
  owners = {},
  defaultOwner = null,
  allowUnowned = false,
  pathStyle,
  platform,
} = {}) {
  const resolvedPathStyle = resolvePathStyle(pathStyle, platform);
  const rules = Object.entries(owners).flatMap(([owner, patterns]) => {
    if (!Array.isArray(patterns)) {
      throw new TypeError(`ownership patterns for ${owner} must be an array`);
    }
    return patterns.map((pattern) => ({
      owner,
      pattern,
      matcher: compileGlob(pattern, { pathStyle: resolvedPathStyle }),
    }));
  });
  return Object.freeze({ rules, defaultOwner, allowUnowned, pathStyle: resolvedPathStyle });
}

export function ownerForPath(policy, filePath) {
  const normalized = normalize(filePath, policy?.pathStyle ?? "posix");
  const matches = policy.rules.filter(({ matcher }) => matcher.test(normalized));
  if (matches.length > 1) {
    const owners = new Set(matches.map(({ owner }) => owner));
    if (owners.size > 1) {
      throw new Error(
        `ambiguous ownership for ${normalized}: ${[...owners].join(", ")}`,
      );
    }
  }
  return matches.at(-1)?.owner ?? policy.defaultOwner;
}

export function checkOwnership(policy, actor, filePaths) {
  if (!policy || !Array.isArray(policy.rules)) {
    throw new TypeError("a compiled ownership policy is required");
  }
  const violations = [];
  for (const filePath of filePaths) {
    const owner = ownerForPath(policy, filePath);
    if (owner === null && !policy.allowUnowned) {
      violations.push({ path: filePath, owner: null, reason: "unowned" });
    } else if (owner !== null && owner !== actor) {
      violations.push({ path: filePath, owner, reason: "wrong-owner" });
    }
  }
  return { allowed: violations.length === 0, violations };
}

export function assertOwnership(policy, actor, filePaths) {
  const result = checkOwnership(policy, actor, filePaths);
  if (!result.allowed) {
    const error = new Error(
      `ownership policy rejected ${result.violations.length} path(s)`,
    );
    error.code = "OWNERSHIP_VIOLATION";
    error.violations = result.violations;
    throw error;
  }
  return result;
}
