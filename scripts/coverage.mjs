#!/usr/bin/env node
// Coverage runner and regression floor, implemented with Node built-ins only so
// the project keeps its zero-dependency guarantee (THIRD_PARTY_NOTICES.md).
//
// Node's own --test-coverage-lines threshold flag only exists from v22.8, and CI
// also runs Node 20, so the floors are enforced here by parsing the built-in lcov
// reporter's output instead. lcov is a stable, trivially parsed format: LF/LH are
// lines found and hit, BRF/BRH branches, and FNF/FNH functions, per file.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_DIRECTORY = "coverage";
const LCOV_FILE = path.join(OUTPUT_DIRECTORY, "lcov.info");

// The floors prevent regression; they are not aspirational targets. Raise one when
// coverage rises, never lower it to make a red run green.
// Baseline measured at 91.93% lines, 82.90% branches, 91.74% functions of src/.
const METRICS = {
  lines: { found: "LF", hit: "LH", noun: "lines", floor: 90, env: "TRESTLE_COVERAGE_MIN_LINES" },
  branches: { found: "BRF", hit: "BRH", noun: "branches", floor: 78, env: "TRESTLE_COVERAGE_MIN_BRANCHES" },
  functions: { found: "FNF", hit: "FNH", noun: "functions", floor: 86, env: "TRESTLE_COVERAGE_MIN_FUNCTIONS" },
};

function parseFloor(value, metric = "lines") {
  const { floor, env } = METRICS[metric];
  if (value === undefined) return floor;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new RangeError(`${env} must be a percentage between 0 and 100, got: ${value}`);
  }
  return parsed;
}

// A malformed counter must never be coerced with Number(): NaN propagates into
// the total, and every comparison against NaN is false, so a corrupt report
// would slip past the floor and report success. Parse strictly and fail loudly.
function parseCount(value, record, file) {
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `malformed ${record} record for ${file ?? "unknown file"}: ${JSON.stringify(raw)}`,
    );
  }
  return Number(raw);
}

function summarize(lcov, metric = "lines") {
  const { found: foundRecord, hit: hitRecord, noun } = METRICS[metric];
  let found = 0;
  let hit = 0;
  let counting = false;
  let current;
  for (const line of lcov.split("\n")) {
    // Only production modules count toward the floor. Node's built-in coverage
    // instruments the test files too, and --test-coverage-exclude does not exist
    // on Node 20, so the records are filtered here instead.
    if (line.startsWith("SF:")) {
      current = path.relative(process.cwd(), path.resolve(line.slice(3).trim()));
      counting = current === "src" || current.startsWith(`src${path.sep}`);
    } else if (!counting) continue;
    else if (line.startsWith(`${foundRecord}:`)) {
      found += parseCount(line.slice(foundRecord.length + 1), foundRecord, current);
    } else if (line.startsWith(`${hitRecord}:`)) {
      hit += parseCount(line.slice(hitRecord.length + 1), hitRecord, current);
    }
  }
  // Zero measured records means instrumentation produced nothing, not that the
  // code is perfectly covered. Fail closed rather than dividing into a 0%/100%
  // argument that depends on the configured floor.
  if (found === 0) throw new Error("no src/ coverage records found in the lcov report");
  if (hit > found) throw new Error(`lcov reports more ${noun} hit (${hit}) than found (${found})`);
  return { found, hit, percent: (hit / found) * 100 };
}

function main() {
  const floors = Object.fromEntries(
    Object.entries(METRICS).map(([metric, { env }]) => [metric, parseFloor(process.env[env], metric)]),
  );
  mkdirSync(OUTPUT_DIRECTORY, { recursive: true });

  const test = spawnSync(process.execPath, [
    "--test",
    "--experimental-test-coverage",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${LCOV_FILE}`,
    ...process.argv.slice(2),
  ], { stdio: "inherit" });

  if (test.status !== 0) {
    process.stderr.write("coverage: tests failed; coverage floors not evaluated\n");
    process.exit(test.status ?? 1);
  }

  let report;
  try {
    report = readFileSync(LCOV_FILE, "utf8");
  } catch (error) {
    process.stderr.write(`coverage: could not read ${LCOV_FILE}: ${error.message}\n`);
    process.exit(1);
  }

  let results;
  try {
    results = Object.keys(METRICS).map((metric) => ({ metric, ...summarize(report, metric) }));
  } catch (error) {
    process.stderr.write(`coverage: unusable lcov report: ${error.message}\n`);
    process.exit(1);
  }

  process.stdout.write("\n");
  for (const { metric, found, hit, percent } of results) {
    process.stdout.write(
      `coverage: ${percent.toFixed(2)}% of src/ ${metric} (${hit}/${found}); floor ${floors[metric]}%\n`,
    );
  }
  process.stdout.write(`coverage: lcov report written to ${LCOV_FILE}\n`);

  // Every metric is reported before any failure exits, so one run names every
  // floor that regressed instead of revealing them one CI run at a time.
  const failures = results.filter(({ metric, percent }) => percent + Number.EPSILON < floors[metric]);
  if (failures.length > 0) {
    for (const { metric, percent } of failures) {
      process.stderr.write(
        `coverage: src/ ${metric} coverage ${percent.toFixed(2)}% is below the ${floors[metric]}% floor\n`,
      );
    }
    process.exit(1);
  }
}

// Exported so the quality gate itself is testable; importing this module must
// not run the suite, so main() only fires when the script is executed directly.
export { parseFloor, summarize };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
