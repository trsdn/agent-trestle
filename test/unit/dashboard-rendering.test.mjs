import assert from "node:assert/strict";
import test from "node:test";
import { renderDashboard } from "../../src/dashboard/index.mjs";

const model = {
  generatedAt: "2026-08-14T12:00:00.000Z",
  projects: [{ id: "p1", name: "Example project", status: "active" }],
  workstreams: [{ id: "w1", name: "Core", status: "running" }],
  runs: [{ id: "r1", name: "Run 1", status: "running" }],
  tasks: [
    { id: "t1", title: "First task", status: "complete", dependencies: [] },
    { id: "t2", title: "Second task", status: "pending", dependsOn: ["t1"] },
  ],
  reviews: [{ id: "v1", name: "Quality gate", status: "passed" }],
  failures: [{ id: "f1", name: "Retry limit", status: "failed" }],
  audit: [{ id: "a1", kind: "dispatch", actor: "operator" }],
  git: { repository: "example", branch: "main", dirty: false },
  guidance: ["Inspect failed runs before retrying."],
};

test("renders every required semantic dashboard section", () => {
  const { html } = renderDashboard(model, { nonce: "fixed" });
  for (const id of [
    "overview",
    "workstreams",
    "runs",
    "tasks",
    "reviews",
    "failures",
    "audit",
    "guidance",
  ]) {
    assert.match(html, new RegExp(`<section id="${id}"`));
    assert.match(html, new RegExp(`aria-labelledby="${id}-heading"`));
  }
  assert.match(html, /<main id="main">/);
  assert.match(html, /Skip to dashboard content/);
  assert.match(html, /DAG and task status/);
  assert.match(html, /Depends on:<\/strong> t1/);
  assert.match(html, /Git status/);
  assert.match(html, /No operator actions are available in v1/);
});

test("renders a generic normalized model without product-specific assumptions", () => {
  const { html, model: normalized } = renderDashboard(model, { nonce: "fixed" });
  assert.equal(normalized.projects[0].name, "Example project");
  assert.match(html, /Example project/);
  assert.doesNotMatch(html, /Acme Corp|Contoso|Northwind/);
  assert.doesNotMatch(html, /https?:\/\//);
});
