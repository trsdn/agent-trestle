// The quality gates are themselves untested code, and a gate that silently
// passes is worse than no gate: it manufactures confidence. These tests pin the
// two failure modes that an independent review found in the hand-written
// tooling, plus the tokenizer edge cases the quote scanner has to survive.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { parseFloor, summarize } from "../../scripts/coverage.mjs";
import { makeScratchRoot } from "../helpers/scratch";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const LINTER = path.join(REPO_ROOT, "scripts", "lint.mjs");

const lcov = (records) => records
  .map(({ file, found, hit }) => `SF:${file}\nLF:${found}\nLH:${hit}\nend_of_record`)
  .join("\n");

const srcFile = (name) => path.join(REPO_ROOT, "src", name);

test("summarize rejects a malformed LF counter instead of coercing it to NaN", () => {
  // Number("nope") is NaN, NaN poisons the total, and every comparison against
  // NaN is false -- so the floor check would pass and report success.
  const report = `SF:${srcFile("a.mjs")}\nLF:not-a-number\nLH:0\nend_of_record`;
  assert.throws(() => summarize(report), /malformed LF record/);
});

test("summarize rejects a malformed LH counter", () => {
  const report = `SF:${srcFile("a.mjs")}\nLF:10\nLH:not-a-number\nend_of_record`;
  assert.throws(() => summarize(report), /malformed LH record/);
});

test("summarize fails closed when the report contains no src records", () => {
  // Zero measured lines means instrumentation broke, not that everything is
  // covered. It must never be reported as a pass at any floor.
  assert.throws(() => summarize(""), /no src\/ coverage records/);
  const testsOnly = lcov([{ file: path.join(REPO_ROOT, "test", "x.test.mjs"), found: 10, hit: 10 }]);
  assert.throws(() => summarize(testsOnly), /no src\/ coverage records/);
});

test("summarize rejects a report claiming more lines hit than found", () => {
  const report = lcov([{ file: srcFile("a.mjs"), found: 5, hit: 9 }]);
  assert.throws(() => summarize(report), /more lines hit/);
});

test("summarize counts only src/ records and computes the real percentage", () => {
  const report = lcov([
    { file: srcFile("a.mjs"), found: 100, hit: 90 },
    { file: path.join(REPO_ROOT, "test", "b.test.mjs"), found: 100, hit: 0 },
    { file: srcFile("c.mjs"), found: 100, hit: 80 },
  ]);
  const { found, hit, percent } = summarize(report);
  assert.equal(found, 200);
  assert.equal(hit, 170);
  assert.equal(percent, 85);
});

test("parseFloor rejects values outside a percentage range", () => {
  assert.equal(parseFloor(undefined), 90);
  assert.equal(parseFloor("75"), 75);
  for (const bad of ["-1", "101", "abc", "NaN", "Infinity"]) {
    assert.throws(() => parseFloor(bad), RangeError, `expected ${bad} to be rejected`);
  }
});

/** Runs the real linter against a throwaway project that mirrors the repo layout. */
async function lintFixture(name, source) {
  const root = await makeScratchRoot(`lint-${name}`);
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  // ROOT is resolved from the script's own location, so the linter has to be
  // copied into the fixture for it to scan the fixture's sources.
  await writeFile(path.join(root, "scripts", "lint.mjs"), await readFile(LINTER, "utf8"));
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  await writeFile(path.join(root, "src", "sample.mjs"), source);
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(root, "scripts", "lint.mjs")]);
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("a regex opening a statement after a block is not misread as a quote violation", async () => {
  // Regression: `regexAllowedAfter("}")` returned false, so the `/` was treated
  // as division and the apostrophe inside the regex looked like a string start,
  // producing a phantom violation on valid code. The regex must sit at
  // statement position -- after `return` the keyword allowlist already covers it,
  // so a `return` here would silently stop exercising the bug.
  const result = await lintFixture("regex-after-block", [
    "export function check(value) {",
    "  if (value) {}",
    "  /'/.test(value);",
    "  return value;",
    "}",
    "",
  ].join("\n"));
  assert.equal(result.ok, true, `linter should accept valid code, got:\n${result.output}`);
});

test("quotes inside regexes, comments and templates are not reported", async () => {
  const result = await lintFixture("tokenizer-edges", [
    "const re = /'/;",
    "const cls = /['\"]/g;",
    "// don't trip on this apostrophe",
    "/* nor 'this' one */",
    "const tpl = `it's fine ${re.source} still fine`;",
    "const nested = `outer ${`inner ${\"deep\"}`} done`;",
    "const escaped = \"a \\\" b\";",
    "const division = (4) / 2 / 1;",
    "export { re, cls, tpl, nested, escaped, division };",
    "",
  ].join("\n"));
  assert.equal(result.ok, true, `linter should accept valid code, got:\n${result.output}`);
});

test("a genuine single-quoted string is still reported", async () => {
  // Guards the opposite failure: a scanner tuned to avoid false positives must
  // not go blind to real violations.
  const result = await lintFixture("real-violation", "export const name = 'trestle';\n");
  assert.equal(result.ok, false, "linter should reject single-quoted strings");
  assert.match(result.output, /single-quoted strings/);
});
