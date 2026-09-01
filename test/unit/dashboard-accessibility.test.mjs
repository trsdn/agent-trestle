import assert from "node:assert/strict";
import test from "node:test";
import { renderDashboard } from "../../src/dashboard/index.mjs";

// Regression coverage for the accessibility properties the README states, so a
// future markup change cannot quietly retract them (criteria X01 to X03).

const populated = {
  generatedAt: "2026-08-14T12:00:00.000Z",
  projects: [{ id: "p1", name: "Example project", status: "active" }],
  workstreams: [{ id: "w1", name: "Core", status: "running" }],
  runs: [{ id: "r1", name: "Run 1", status: "running" }],
  tasks: [{ id: "t1", title: "First task", status: "complete", dependencies: [] }],
  reviews: [{ id: "v1", name: "Quality gate", status: "passed" }],
  failures: [{ id: "f1", name: "Retry limit", status: "failed" }],
  audit: [{ id: "a1", kind: "dispatch", actor: "operator" }],
  git: { repository: "example", branch: "main", dirty: false },
  guidance: ["Inspect failed runs before retrying."],
};

const empty = { generatedAt: "2026-08-14T12:00:00.000Z" };

test("declares a document language and landmark structure", () => {
  const { html } = renderDashboard(populated, { nonce: "fixed" });
  assert.match(html, /<html lang="en">/);
  for (const landmark of ["<header>", "<nav ", "<main id=\"main\">", "<footer>"]) {
    assert.ok(html.includes(landmark), `missing landmark ${landmark}`);
  }
  assert.match(html, /<nav aria-label="Dashboard sections">/);
});

test("puts a working skip link ahead of the navigation", () => {
  const { html } = renderDashboard(populated, { nonce: "fixed" });
  const skip = html.indexOf('<a class="skip" href="#main">');
  const nav = html.indexOf("<nav ");
  assert.ok(skip > -1, "skip link is missing");
  assert.ok(skip < nav, "skip link must precede the navigation");
  // Off-screen until focused, then visible: a hidden skip link is not a skip link.
  assert.match(html, /\.skip\{position:absolute;left:-9999px\}/);
  assert.match(html, /\.skip:focus\{/);
});

test("keeps a visible focus affordance on navigation links", () => {
  const { html } = renderDashboard(populated, { nonce: "fixed" });
  assert.match(html, /nav a:focus/);
});

test("names every list and section for assistive technology", () => {
  const { html } = renderDashboard(populated, { nonce: "fixed" });
  for (const id of ["overview", "workstreams", "runs", "tasks", "reviews", "failures", "audit", "guidance"]) {
    assert.match(html, new RegExp(`<h2 id="${id}-heading">`));
  }
  assert.match(html, /<ul class="cards" aria-label="[^"]+">/);
});

test("announces empty collections instead of rendering silence", () => {
  const { html } = renderDashboard(empty, { nonce: "fixed" });
  assert.match(html, /<p class="empty" role="status">No /);
});

test("never conveys status by colour alone", () => {
  const { html } = renderDashboard(populated, { nonce: "fixed" });
  // Each coloured badge carries the status word as text.
  for (const status of ["running", "complete", "passed", "failed", "active"]) {
    assert.match(html, new RegExp(`<span class="status ${status}">${status}</span>`));
  }
});

test("sizes text in relative units so platform text settings apply", () => {
  const { html } = renderDashboard(populated, { nonce: "fixed" });
  const styles = /<style nonce="fixed">([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
  assert.notEqual(styles, "");
  assert.equal(/font-size:[^;}]*px/.test(styles), false, "font sizes must not be fixed in px");
  assert.match(styles, /@media\(prefers-color-scheme:dark\)/);
  assert.match(styles, /@media\(max-width:35rem\)/);
});
