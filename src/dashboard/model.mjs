const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 1_000_000,
  maxItems: 1_000,
  maxStringLength: 10_000,
  maxDepth: 12,
});

const COLLECTIONS = [
  "projects",
  "workstreams",
  "runs",
  "tasks",
  "reviews",
  "audit",
];

export function normalizeDashboardModel(input, limits = {}) {
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  assertBounded(input, resolved);

  const source = isRecord(input) ? input : {};
  const model = {};
  for (const name of COLLECTIONS) {
    model[name] = Array.isArray(source[name])
      ? source[name].slice(0, resolved.maxItems).map(normalizeRecord)
      : [];
  }

  model.failures = Array.isArray(source.failures)
    ? source.failures.slice(0, resolved.maxItems).map(normalizeRecord)
    : deriveFailures(model);
  model.git = isRecord(source.git) ? normalizeRecord(source.git) : {};
  model.guidance = Array.isArray(source.guidance)
    ? source.guidance.slice(0, resolved.maxItems).map(normalizeGuidance)
    : [];
  model.generatedAt =
    typeof source.generatedAt === "string"
      ? source.generatedAt
      : new Date().toISOString();

  return model;
}

function deriveFailures(model) {
  return [...model.runs, ...model.tasks, ...model.reviews]
    .filter((item) => ["failed", "blocked", "rejected"].includes(item.status))
    .map((item) => ({
      id: item.id,
      kind: item.kind ?? "status",
      name: item.name ?? item.title ?? item.id,
      status: item.status,
      message: item.message ?? item.summary ?? "",
    }));
}

function normalizeGuidance(value) {
  return typeof value === "string" ? { text: value } : normalizeRecord(value);
}

function normalizeRecord(value) {
  if (!isRecord(value)) return { value: scalar(value) };
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      Array.isArray(entry)
        ? entry.map((item) => (isRecord(item) ? normalizeRecord(item) : scalar(item)))
        : isRecord(entry)
          ? normalizeRecord(entry)
          : scalar(entry),
    ]),
  );
}

function scalar(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  return String(value ?? "");
}

function assertBounded(value, limits) {
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value));
  } catch {
    throw new TypeError("Dashboard model must be JSON-serializable");
  }
  if (bytes > limits.maxBytes) {
    throw new RangeError(`Dashboard model exceeds ${limits.maxBytes} bytes`);
  }

  const visit = (entry, depth) => {
    if (depth > limits.maxDepth) {
      throw new RangeError(`Dashboard model exceeds depth ${limits.maxDepth}`);
    }
    if (typeof entry === "string" && entry.length > limits.maxStringLength) {
      throw new RangeError(
        `Dashboard string exceeds ${limits.maxStringLength} characters`,
      );
    }
    if (Array.isArray(entry)) {
      if (entry.length > limits.maxItems) {
        throw new RangeError(`Dashboard collection exceeds ${limits.maxItems} items`);
      }
      for (const item of entry) visit(item, depth + 1);
    } else if (isRecord(entry)) {
      for (const item of Object.values(entry)) visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export { DEFAULT_LIMITS };
