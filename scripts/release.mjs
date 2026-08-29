#!/usr/bin/env node
// Dependency-free release metadata checks.
//
// A published artifact must be traceable back to the tag that produced it, so
// the release workflow runs both subcommands before anything is uploaded:
//
//   verify --tag vX.Y.Z            fail unless the tag, `package.json`
//                                  version, and changelog section agree
//   notes --tag vX.Y.Z [--out F]   emit the changelog section for the tag
//
// Usage: node scripts/release.mjs <verify|notes> --tag <tag> [--out <file>]

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const TAG_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Strip the release tag prefix, rejecting anything that is not `vX.Y.Z`. */
export function versionFromTag(tag) {
  if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
    throw new Error(`Tag "${tag}" is not a v-prefixed semantic version such as v1.2.3`);
  }
  return tag.slice(1);
}

/** Return the changelog body documenting one version, without its heading. */
export function extractReleaseNotes(changelog, version) {
  const escaped = version.replace(/[.+]/g, "\\$&");
  const heading = new RegExp(`^## \\[?${escaped}\\]?(?![0-9A-Za-z.+-])`);
  const lines = String(changelog).split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    throw new Error(`CHANGELOG.md documents no "## [${version}]" section`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  if (body === "") {
    throw new Error(`The "## [${version}]" changelog section is empty`);
  }
  return body;
}

/** Parse the flag pairs this script accepts, rejecting anything unexpected. */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag !== "--tag" && flag !== "--out") {
      throw new Error(`Unknown argument "${flag}"`);
    }
    const value = rest[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}`);
    }
    options[flag.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command !== "verify" && command !== "notes") {
    throw new Error("Usage: node scripts/release.mjs <verify|notes> --tag <tag> [--out <file>]");
  }

  const version = versionFromTag(options.tag);
  const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
  if (pkg.version !== version) {
    throw new Error(`Tag ${options.tag} disagrees with package.json version ${pkg.version}`);
  }
  const notes = extractReleaseNotes(await readFile(resolve(ROOT, "CHANGELOG.md"), "utf8"), version);

  if (command === "notes") {
    if (options.out) await writeFile(resolve(process.cwd(), options.out), `${notes}\n`, "utf8");
    else process.stdout.write(`${notes}\n`);
    return;
  }
  process.stdout.write(
    `${pkg.name} ${version} matches ${options.tag} and its CHANGELOG.md section\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`release: ${error.message}\n`);
    process.exitCode = 1;
  });
}
