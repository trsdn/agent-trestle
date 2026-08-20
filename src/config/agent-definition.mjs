import { readdir } from "node:fs/promises";
import path from "node:path";
import { pinDirectory, readVerifiedFile, releasePin, verifyDescendant } from "../security/path-security.mjs";

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineList(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const body = trimmed.slice(1, -1).trim();
  if (body === "") return [];
  return body.split(",").map(unquote).filter(Boolean);
}

export function parseAgentFrontmatter(source, { filename = "<agent>" } = {}) {
  if (typeof source !== "string") throw new TypeError("Agent definition must be text");
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") throw new SyntaxError(`${filename} must begin with YAML frontmatter`);
  const closing = lines.indexOf("---", 1);
  if (closing === -1) throw new SyntaxError(`${filename} has unterminated YAML frontmatter`);

  const values = {};
  let listKey;
  for (const rawLine of lines.slice(1, closing)) {
    if (/^\s*$|^\s*#/.test(rawLine)) continue;
    const listItem = rawLine.match(/^\s+-\s+(.+)$/);
    if (listItem && listKey) {
      values[listKey].push(unquote(listItem[1]));
      continue;
    }
    if (/^\s+/.test(rawLine)) {
      if (listKey) throw new SyntaxError(`${filename} contains an invalid list item: ${rawLine}`);
      continue;
    }
    const pair = rawLine.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!pair) throw new SyntaxError(`${filename} contains unsupported frontmatter: ${rawLine}`);
    const [, key, rawValue = ""] = pair;
    const inline = parseInlineList(rawValue);
    if (inline) {
      values[key] = inline;
      listKey = undefined;
    } else if (rawValue.trim() === "") {
      values[key] = [];
      listKey = key;
    } else {
      values[key] = unquote(rawValue);
      listKey = undefined;
    }
  }

  if (typeof values.model !== "string" || values.model === "") {
    throw new TypeError(`${filename} frontmatter must declare model`);
  }
  if (values.skills !== undefined && (!Array.isArray(values.skills) || values.skills.some((skill) => !skill))) {
    throw new TypeError(`${filename} frontmatter skills must be a list`);
  }
  return {
    model: values.model,
    skills: values.skills ?? [],
    frontmatter: values,
    body: lines.slice(closing + 1).join("\n"),
  };
}

export async function loadAgentDefinition(projectRoot, agentId, {
  pinDirectoryImpl = pinDirectory,
  readVerifiedFileImpl = readVerifiedFile,
  beforeOpen,
  beforeUse,
} = {}) {
  if (typeof agentId !== "string" || !/^[a-zA-Z0-9._-]+$/.test(agentId)) {
    throw new TypeError("agentId must be an explicit safe ID");
  }
  const agentsDir = path.resolve(projectRoot, ".github", "agents");
  const filename = path.resolve(agentsDir, `${agentId}.agent.md`);
  const pin = await pinDirectoryImpl(projectRoot);
  let parsed;
  try {
    parsed = parseAgentFrontmatter(
      await readVerifiedFileImpl(pin, filename, { beforeOpen, beforeUse }),
      { filename },
    );
  } finally {
    await releasePin(pin);
  }
  return { id: agentId, path: filename, ...parsed };
}

export async function loadAgentDefinitions(projectRoot, {
  readdirImpl = readdir,
  pinDirectoryImpl = pinDirectory,
  verifyDescendantImpl = verifyDescendant,
  readVerifiedFileImpl = readVerifiedFile,
  beforeOpen,
  beforeUse,
} = {}) {
  const directory = path.resolve(projectRoot, ".github", "agents");
  const pin = await pinDirectoryImpl(projectRoot);
  let names;
  try {
    await verifyDescendantImpl(pin, directory, { allowMissing: false });
    names = (await readdirImpl(directory))
      .filter((name) => name.endsWith(".agent.md"))
      .sort((a, b) => a.localeCompare(b));
  } finally {
    await releasePin(pin);
  }
  return Promise.all(names.map((name) => loadAgentDefinition(projectRoot, name.slice(0, -9), {
    pinDirectoryImpl,
    readVerifiedFileImpl,
    beforeOpen,
    beforeUse,
  })));
}
