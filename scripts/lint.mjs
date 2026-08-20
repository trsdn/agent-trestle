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
//
// Usage: node scripts/lint.mjs [--fix]

import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = resolve(import.meta.dirname, '..');
const SCAN_DIRS = ['src', 'test', 'scripts', 'schemas', 'examples', 'templates'];
const IGNORED_DIRS = new Set(['node_modules', '.git', '.work', '.artifacts']);
const JS_EXTENSIONS = /\.m?js$/;
const FIX = process.argv.includes('--fix');

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
    await execFileAsync(process.execPath, ['--check', file]);
  } catch (error) {
    const detail = String(error.stderr || error.message)
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('    at '))
      .slice(0, 4)
      .join(' ');
    report(file, `syntax error: ${detail}`);
  }
}

async function checkJson(file) {
  const source = await readFile(file, 'utf8');
  try {
    JSON.parse(source);
  } catch (error) {
    report(file, `invalid JSON: ${error.message}`);
  }
}

async function checkWhitespace(file) {
  const source = await readFile(file, 'utf8');
  if (source.length === 0) return;

  let repaired = source;

  if (source.includes('\r\n')) {
    report(file, 'uses CRLF line endings; expected LF');
    repaired = repaired.replaceAll('\r\n', '\n');
  }
  if (/[ \t]+$/m.test(repaired)) {
    report(file, 'has trailing whitespace');
    repaired = repaired.replaceAll(/[ \t]+$/gm, '');
  }
  if (!repaired.endsWith('\n')) {
    report(file, 'missing final newline');
    repaired += '\n';
  }

  if (FIX && repaired !== source) {
    await writeFile(file, repaired);
    fixed.push(relative(ROOT, file));
  }
}

const files = (
  await Promise.all(SCAN_DIRS.map((dir) => collectFiles(resolve(ROOT, dir))))
).flat();

await Promise.all(
  files.map(async (file) => {
    await checkWhitespace(file);
    if (JS_EXTENSIONS.test(file)) await checkSyntax(file);
    else if (file.endsWith('.json')) await checkJson(file);
  }),
);

if (fixed.length > 0) {
  console.log(`Fixed whitespace in ${fixed.length} file(s):`);
  for (const file of fixed.sort()) console.log(`  ${file}`);
}

const remaining = FIX
  ? problems.filter((problem) => !/trailing whitespace|final newline|CRLF/.test(problem))
  : problems;

if (remaining.length > 0) {
  console.error(`\nLint failed with ${remaining.length} problem(s):`);
  for (const problem of remaining.sort()) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`Lint passed: ${files.length} file(s) checked.`);
