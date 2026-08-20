import { randomBytes } from "node:crypto";
import { normalizeDashboardModel } from "./model.mjs";

const STATUS_CLASSES = new Set([
  "active",
  "blocked",
  "complete",
  "failed",
  "passed",
  "pending",
  "rejected",
  "running",
]);

export function renderDashboard(input, options = {}) {
  const model = normalizeDashboardModel(input, options.limits);
  const nonce = options.nonce ?? randomBytes(18).toString("base64");
  const title = options.title ?? "Agent Trestle Dashboard";
  const counts = {
    projects: model.projects.length,
    workstreams: model.workstreams.length,
    activeRuns: model.runs.filter((item) =>
      ["active", "running", "pending"].includes(item.status),
    ).length,
    failures: model.failures.length,
  };

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>${escapeHtml(title)}</title>
  <style nonce="${escapeHtml(nonce)}">${styles}</style>
</head>
<body>
  <a class="skip" href="#main">Skip to dashboard content</a>
  <header>
    <p class="eyebrow">Local read-only control plane</p>
    <h1>${escapeHtml(title)}</h1>
    <p>Snapshot generated <time datetime="${escapeHtml(model.generatedAt)}">${escapeHtml(model.generatedAt)}</time></p>
  </header>
  <nav aria-label="Dashboard sections">
    ${navLink("overview", "Overview")}
    ${navLink("workstreams", "Workstreams")}
    ${navLink("runs", "Active runs")}
    ${navLink("tasks", "Tasks")}
    ${navLink("reviews", "Reviews")}
    ${navLink("failures", "Failures")}
    ${navLink("audit", "Audit")}
    ${navLink("guidance", "Guidance")}
  </nav>
  <main id="main">
    <section id="overview" aria-labelledby="overview-heading">
      <h2 id="overview-heading">Overview</h2>
      <div class="metrics">
        ${metric("Projects", counts.projects)}
        ${metric("Workstreams", counts.workstreams)}
        ${metric("Active runs", counts.activeRuns)}
        ${metric("Failures", counts.failures)}
      </div>
      ${renderCollection("Projects", model.projects)}
      ${renderGit(model.git)}
    </section>
    ${section("workstreams", "Workstreams", model.workstreams)}
    ${section("runs", "Active runs", model.runs.filter((item) => ["active", "running", "pending"].includes(item.status)))}
    ${section("tasks", "DAG and task status", model.tasks, renderTask)}
    ${section("reviews", "Review state", model.reviews)}
    ${section("failures", "Failures", model.failures)}
    ${section("audit", "Audit trail", model.audit)}
    ${section("guidance", "Operator guidance", model.guidance)}
  </main>
  <footer><p>Read-only dashboard. No operator actions are available in v1.</p></footer>
  <script type="application/json" id="dashboard-model" nonce="${escapeHtml(nonce)}">${safeJson(model)}</script>
  <script nonce="${escapeHtml(nonce)}">
    document.documentElement.classList.add("js");
    for (const link of document.querySelectorAll("nav a")) {
      link.addEventListener("click", () => link.setAttribute("aria-current", "location"));
    }
  </script>
</body>
</html>`;
  return { html, nonce, model };
}

function section(id, heading, items, renderer = renderRecord) {
  return `<section id="${id}" aria-labelledby="${id}-heading">
    <h2 id="${id}-heading">${escapeHtml(heading)}</h2>
    ${renderCollection(heading, items, renderer)}
  </section>`;
}

function renderCollection(label, items, renderer = renderRecord) {
  if (items.length === 0) {
    return `<p class="empty" role="status">No ${escapeHtml(label.toLowerCase())} in this snapshot.</p>`;
  }
  return `<ul class="cards" aria-label="${escapeHtml(label)}">${items.map((item) => `<li>${renderer(item)}</li>`).join("")}</ul>`;
}

function renderRecord(item) {
  const heading = item.name ?? item.title ?? item.id ?? item.kind ?? "Item";
  const excluded = new Set(["name", "title"]);
  return `<article>
    <div class="card-heading"><h3>${escapeHtml(heading)}</h3>${status(item.status)}</div>
    <dl>${Object.entries(item)
      .filter(([key, value]) => !excluded.has(key) && value !== "" && value != null)
      .map(([key, value]) => `<div><dt>${escapeHtml(label(key))}</dt><dd>${formatValue(value)}</dd></div>`)
      .join("")}</dl>
  </article>`;
}

function renderTask(task) {
  const dependencies = Array.isArray(task.dependencies)
    ? task.dependencies
    : Array.isArray(task.dependsOn)
      ? task.dependsOn
      : [];
  return `${renderRecord(task)}
    <p class="dependencies"><strong>Depends on:</strong> ${dependencies.length ? dependencies.map(escapeHtml).join(", ") : "None"}</p>`;
}

function renderGit(git) {
  if (Object.keys(git).length === 0) return "";
  return `<aside aria-labelledby="git-heading"><h3 id="git-heading">Git status</h3>${renderRecord({ name: git.repository ?? "Repository", ...git })}</aside>`;
}

function metric(labelText, value) {
  return `<article class="metric"><span>${escapeHtml(labelText)}</span><strong>${value}</strong></article>`;
}

function navLink(id, text) {
  return `<a href="#${id}">${escapeHtml(text)}</a>`;
}

function status(value) {
  if (!value) return "";
  const normalized = String(value).toLowerCase();
  const className = STATUS_CLASSES.has(normalized) ? normalized : "neutral";
  return `<span class="status ${className}">${escapeHtml(value)}</span>`;
}

function formatValue(value) {
  if (Array.isArray(value)) return value.map(escapeHtml).join(", ");
  if (value && typeof value === "object") {
    return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
  }
  return escapeHtml(value);
}

function label(value) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

const styles = `
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#172033;background:#f3f6fb;line-height:1.5}
*{box-sizing:border-box}body{margin:0}header,nav,main,footer{max-width:78rem;margin:auto;padding:1rem 1.5rem}
header{padding-top:2.5rem}.eyebrow{color:#3559a6;font-weight:700;text-transform:uppercase;letter-spacing:.08em}
h1,h2,h3{line-height:1.2}nav{display:flex;gap:.5rem;overflow:auto;position:sticky;top:0;background:#f3f6fbe8;backdrop-filter:blur(8px);z-index:2}
nav a{color:#24447d;padding:.5rem .75rem;border-radius:.4rem;white-space:nowrap}nav a:focus,nav a:hover{background:#dce7ff}
section{scroll-margin-top:4rem;margin:1.5rem 0;padding:1.25rem;background:white;border:1px solid #dbe2ef;border-radius:.75rem}
.metrics,.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:1rem}.cards{list-style:none;padding:0}
.cards>li,article,aside{border:1px solid #dbe2ef;border-radius:.5rem;padding:1rem}.card-heading{display:flex;justify-content:space-between;gap:1rem}
.card-heading h3{margin-top:0}dl{margin:0}dl div{display:grid;grid-template-columns:minmax(7rem,1fr) 2fr;gap:.75rem;border-top:1px solid #edf0f5;padding:.4rem 0}
dt{font-weight:650;text-transform:capitalize}dd{margin:0;overflow-wrap:anywhere}.metric strong{display:block;font-size:2rem}
.status{align-self:start;border-radius:999px;padding:.15rem .55rem;background:#e8edf5;font-size:.8rem;font-weight:700}
.passed,.complete{background:#d8f4df;color:#145629}.failed,.rejected,.blocked{background:#ffe0df;color:#7d1713}.active,.running{background:#dce7ff;color:#173f86}
.pending{background:#fff0c7;color:#684b00}.empty{color:#58657a}.skip{position:absolute;left:-9999px}.skip:focus{left:1rem;top:1rem;background:white;padding:.5rem;z-index:5}
code{white-space:normal;overflow-wrap:anywhere}@media(prefers-color-scheme:dark){:root{color:#e8edf7;background:#101522}section{background:#171e2d;border-color:#34405a}
nav{background:#101522e8}nav a{color:#a9c4ff}.cards>li,article,aside{border-color:#34405a}dl div{border-color:#29344c}.empty{color:#aeb8ca}}
@media(max-width:35rem){dl div{grid-template-columns:1fr}.metrics,.cards{grid-template-columns:1fr}}
`;
