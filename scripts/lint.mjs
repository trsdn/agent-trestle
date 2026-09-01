#!/usr/bin/env node
// Dependency-free lint pass.
//
// Agent Trestle intentionally ships with no npm runtime or development
// dependencies (see THIRD_PARTY_NOTICES.md), so this replaces ESLint/Prettier
// with checks built from Node built-ins only:
//
//   1. syntax validation of every JavaScript module via `node --check`
//   2. JSON parse validation
//   3. whitespace hygiene matching .editorconfig
//   4. string quote style
//
// Usage: node scripts/lint.mjs [--fix]

import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = resolve(import.meta.dirname, "..");
const SCAN_DIRS = ["src", "test", "scripts", "schemas", "examples", "templates"];
const IGNORED_DIRS = new Set(["node_modules", ".git", ".work", ".artifacts"]);
const JS_EXTENSIONS = /\.m?js$/;
const FIX = process.argv.includes("--fix");

/** Recursively collect every scannable file under a directory. */
async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        return IGNORED_DIRS.has(entry.name) ? [] : collectFiles(full);
      }
      return entry.isFile() ? [full] : [];
    }),
  );
  return files.flat();
}

const problems = [];
const fixed = [];

function report(file, message) {
  problems.push(`${relative(ROOT, file)}: ${message}`);
}

async function checkSyntax(file) {
  try {
    await execFileAsync(process.execPath, ["--check", file]);
  } catch (error) {
    const detail = String(error.stderr || error.message)
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("    at "))
      .slice(0, 4)
      .join(" ");
    report(file, `syntax error: ${detail}`);
  }
}

async function checkJson(file) {
  const source = await readFile(file, "utf8");
  try {
    JSON.parse(source);
  } catch (error) {
    report(file, `invalid JSON: ${error.message}`);
  }
}

async function checkWhitespace(file) {
  const source = await readFile(file, "utf8");
  if (source.length === 0) return;

  let repaired = source;

  if (source.includes("\r\n")) {
    report(file, "uses CRLF line endings; expected LF");
    repaired = repaired.replaceAll("\r\n", "\n");
  }
  if (/[ \t]+$/m.test(repaired)) {
    report(file, "has trailing whitespace");
    repaired = repaired.replaceAll(/[ \t]+$/gm, "");
  }
  if (!repaired.endsWith("\n")) {
    report(file, "missing final newline");
    repaired += "\n";
  }

  if (FIX && repaired !== source) {
    await writeFile(file, repaired);
    fixed.push(relative(ROOT, file));
  }
}

// Keywords after which a `/` begins a regular expression rather than a
// division. Without this the scanner would mistake a regex body for code and
// misread any quote inside it.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw",
]);

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;

function regexAllowedAfter(token) {
  if (token === "") return true;
  if (IDENTIFIER_START.test(token[0])) return REGEX_PRECEDING_KEYWORDS.has(token);
  // `}` is deliberately absent here. A `/` after a closing brace almost always
  // opens a regex at the start of a new statement (`if (a) {}` followed by
  // `/re/.test(x)`), whereas dividing the result of a block or object literal
  // requires parentheses and so ends in `)`. Treating `}` as division made the
  // scanner misread the regex body and report phantom quote violations.
  return !([")", "]"].includes(token) || /[0-9]/.test(token));
}

/**
 * Locates every string literal in a JavaScript source, skipping comments,
 * regular expressions and template literals. A mode stack keeps `${...}`
 * interpolations scanned as code, so a quote inside an interpolation is found
 * and a quote inside template text is not.
 */
function scanStringLiterals(source) {
  const literals = [];
  const modes = [{ kind: "code", braces: 0 }];
  let lastToken = "";
  let i = 0;

  while (i < source.length) {
    const mode = modes.at(-1);
    const char = source[i];

    if (mode.kind === "template") {
      if (char === "\\") { i += 2; continue; }
      if (char === "`") { modes.pop(); lastToken = "`"; i += 1; continue; }
      if (char === "$" && source[i + 1] === "{") {
        modes.push({ kind: "code", braces: 0 });
        lastToken = "";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const start = i;
      i += 1;
      while (i < source.length && source[i] !== char) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      literals.push({ quote: char, start, body: source.slice(start + 1, i) });
      lastToken = char;
      i += 1;
      continue;
    }
    if (char === "`") {
      modes.push({ kind: "template" });
      i += 1;
      continue;
    }
    if (char === "/" && regexAllowedAfter(lastToken)) {
      i += 1;
      let inClass = false;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        else if (source[i] === "/" && !inClass) break;
        else if (source[i] === "\n") break;
        i += 1;
      }
      lastToken = "/";
      i += 1;
      continue;
    }
    if (char === "{") { mode.braces += 1; lastToken = char; i += 1; continue; }
    if (char === "}") {
      if (mode.braces === 0 && modes.length > 1) { modes.pop(); i += 1; continue; }
      mode.braces -= 1;
      lastToken = char;
      i += 1;
      continue;
    }
    if (IDENTIFIER_START.test(char)) {
      const start = i;
      while (i < source.length && IDENTIFIER_PART.test(source[i])) i += 1;
      lastToken = source.slice(start, i);
      continue;
    }
    if (!/\s/.test(char)) lastToken = char;
    i += 1;
  }

  return literals;
}

/**
 * Double quotes are the project default. A single-quoted literal whose body
 * contains a double quote is left alone, because rewriting it would only trade
 * one set of escapes for a larger one.
 */
async function checkQuoteStyle(file) {
  const source = await readFile(file, "utf8");
  const offenders = scanStringLiterals(source)
    .filter((literal) => literal.quote === "'" && !literal.body.includes('"'));
  if (offenders.length === 0) return;

  const lineOf = (index) => source.slice(0, index).split("\n").length;
  if (!FIX) {
    const lines = [...new Set(offenders.map((literal) => lineOf(literal.start)))];
    report(
      file,
      `uses single-quoted strings; expected double quotes (line${lines.length > 1 ? "s" : ""} ${lines.join(", ")})`,
    );
    return;
  }

  let repaired = "";
  let cursor = 0;
  for (const literal of offenders) {
    const end = literal.start + literal.body.length + 2;
    repaired += source.slice(cursor, literal.start);
    repaired += `"${literal.body.replaceAll("\\'", "'")}"`;
    cursor = end;
  }
  repaired += source.slice(cursor);
  await writeFile(file, repaired);
  fixed.push(relative(ROOT, file));
}

const files = (
  await Promise.all(SCAN_DIRS.map((dir) => collectFiles(resolve(ROOT, dir))))
).flat();

await Promise.all(
  files.map(async (file) => {
    await checkWhitespace(file);
    if (JS_EXTENSIONS.test(file)) {
      await checkQuoteStyle(file);
      await checkSyntax(file);
    } else if (file.endsWith(".json")) await checkJson(file);
  }),
);

if (fixed.length > 0) {
  const unique = [...new Set(fixed)].sort();
  console.log(`Fixed ${unique.length} file(s):`);
  for (const file of unique) console.log(`  ${file}`);
}

const remaining = FIX
  ? problems.filter((problem) =>
    !/trailing whitespace|final newline|CRLF|single-quoted strings/.test(problem))
  : problems;

if (remaining.length > 0) {
  console.error(`\nLint failed with ${remaining.length} problem(s):`);
  for (const problem of remaining.sort()) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`Lint passed: ${files.length} file(s) checked.`);
