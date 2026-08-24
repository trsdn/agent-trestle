import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { extractReleaseNotes, versionFromTag } from "../../scripts/release.mjs";

const changelog = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "## [1.2.0] — 2026-01-02",
  "",
  "### Added",
  "",
  "- A documented change.",
  "",
  "## [1.2.0-rc.1] — 2026-01-01",
  "",
  "- A candidate change.",
  "",
].join("\n");

test("release tags are accepted only as v-prefixed semantic versions", () => {
  assert.equal(versionFromTag("v1.2.3"), "1.2.3");
  assert.equal(versionFromTag("v1.2.3-rc.1"), "1.2.3-rc.1");
  for (const rejected of ["1.2.3", "v1.2", "v1.2.3.4", "release-1.2.3", "v01.2.3", "", undefined]) {
    assert.throws(() => versionFromTag(rejected), /not a v-prefixed semantic version/);
  }
});

test("release notes come from the changelog section that documents the version", () => {
  assert.equal(extractReleaseNotes(changelog, "1.2.0"), "### Added\n\n- A documented change.");
  assert.equal(extractReleaseNotes(changelog, "1.2.0-rc.1"), "- A candidate change.");
  assert.throws(() => extractReleaseNotes(changelog, "9.9.9"), /documents no "## \[9\.9\.9\]"/);
  assert.throws(() => extractReleaseNotes(changelog, "Unreleased"), /section is empty/);
});

test("the released package version keeps a documented changelog section", async () => {
  const root = path.resolve(".");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const notes = extractReleaseNotes(await readFile(path.join(root, "CHANGELOG.md"), "utf8"), pkg.version);
  assert.ok(notes.length > 0, `CHANGELOG.md must document ${pkg.version}`);
});
