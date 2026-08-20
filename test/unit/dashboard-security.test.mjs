import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile, rm } from "node:fs/promises";
import test from "node:test";
import {
  createDashboardServer,
  createJsonFileDataProvider,
  createStaticDataProvider,
  normalizeDashboardModel,
  renderDashboard,
} from "../../src/dashboard/index.mjs";

test("escapes rendered output and safely embeds JSON", () => {
  const attack = "</script><script>alert('xss')</script><img src=x onerror=alert(1)>";
  const { html } = renderDashboard(
    { projects: [{ name: attack }], guidance: [attack] },
    { nonce: "fixed" },
  );
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;\/script&gt;/);
  assert.match(html, /\\u003c\/script\\u003e/);
});

test("renders untrusted keys, nested values, statuses, titles, and URLs only as inert text", () => {
  const attack = `"><svg/onload=alert(1)><a href="javascript:alert(2)">`;
  const { html } = renderDashboard({
    generatedAt: attack,
    tasks: [{
      name: attack,
      status: attack,
      [attack]: { html: "</script><script>alert(3)</script>" },
      dependencies: [attack],
      url: "javascript:alert(4)",
    }],
    git: { repository: attack },
  }, { nonce: attack, title: attack });

  assert.doesNotMatch(html, /<svg|<script>alert|href="javascript:/);
  assert.doesNotMatch(html, /class="status [^"]*[<>]/);
  assert.match(html, /&lt;svg\/onload=alert\(1\)&gt;/);
  assert.match(html, /javascript:alert\(4\)/);
  assert.match(html, /\\u003c\/script\\u003e\\u003cscript\\u003e/);
});

test("rejects oversized, deep, and non-serializable input", () => {
  assert.throws(
    () => normalizeDashboardModel({ guidance: ["x".repeat(11)] }, { maxStringLength: 10 }),
    RangeError,
  );
  assert.throws(
    () => normalizeDashboardModel({ git: { a: { b: { c: 1 } } } }, { maxDepth: 2 }),
    RangeError,
  );
  const circular = {};
  circular.self = circular;
  assert.throws(() => normalizeDashboardModel(circular), TypeError);
});

test("file provider enforces a byte limit", async () => {
  const file = new URL("./dashboard-oversized-fixture.json", import.meta.url);
  await writeFile(file, JSON.stringify({ guidance: ["x".repeat(100)] }));
  try {
    const provider = createJsonFileDataProvider(file, { maxFileBytes: 20 });
    await assert.rejects(provider(), RangeError);
  } finally {
    await rm(file);
  }
});

test("server defaults to loopback, is read-only, and sends security headers", async (t) => {
  const dashboard = createDashboardServer({
    dataProvider: createStaticDataProvider({ projects: [] }),
  });
  assert.equal(dashboard.host, "127.0.0.1");
  const address = await dashboard.listen();
  t.after(() => dashboard.close());
  const base = `http://127.0.0.1:${address.port}`;

  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(await page.text(), /Agent Trestle Dashboard/);

  const mutation = await fetch(base, { method: "POST" });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get("allow"), "GET, HEAD");

  const missing = await fetch(`${base}/missing`);
  assert.equal(missing.status, 404);
});

test("server converts provider failures into a bounded generic error", async (t) => {
  const dashboard = createDashboardServer({
    dataProvider: async () => {
      throw new Error("sensitive provider detail");
    },
  });
  const address = await dashboard.listen();
  t.after(() => dashboard.close());
  const response = await fetch(`http://127.0.0.1:${address.port}`);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), "Dashboard unavailable\n");
});
