import { randomBytes } from "node:crypto";
import path from "node:path";
import { createAuditSegmentWriter } from "./audit.mjs";

export const AUDIT_DIRECTORY = ".trestle/audit";

/**
 * An audit write that fails must not degrade into a success-shaped result, so
 * the failure is raised with a distinct type rather than swallowed. Callers
 * surface it as a command failure.
 */
export class AuditRecordingError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "AuditRecordingError";
    this.code = "AUDIT_WRITE_FAILED";
  }
}

export function auditRootFor(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    throw new TypeError("projectRoot must be an explicit path");
  }
  return path.resolve(projectRoot, ".trestle", "audit");
}

/** Audit IDs are constrained to `[A-Za-z0-9][A-Za-z0-9._-]*` by the writer. */
export function generateRunId(prefix = "run") {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

export function routeTaskId({ projectId, workstreamId, roleId }) {
  return `${projectId}.${workstreamId}.${roleId}`;
}

const disabledRecorder = Object.freeze({
  enabled: false,
  async record() { return null; },
});

/**
 * Creates a per-actor audit recorder. Writers are intentionally scoped per
 * actor rather than funnelled through one global segment: the segment design
 * exists specifically so that parallel writers never share a hash chain.
 */
export function createAuditRecorder({
  projectRoot,
  auditRoot = projectRoot === undefined ? undefined : auditRootFor(projectRoot),
  runId,
  taskId,
  writerId,
  enabled = true,
  createWriter = createAuditSegmentWriter,
  clock,
} = {}) {
  if (!enabled) return disabledRecorder;
  const writer = createWriter({
    auditRoot,
    runId,
    taskId,
    writerId,
    ...(clock === undefined ? {} : { clock }),
  });
  return {
    enabled: true,
    auditRoot,
    runId,
    taskId,
    writerId,
    async record(type, detail = {}) {
      if (typeof type !== "string" || type.trim() === "") {
        throw new TypeError("an audit event requires an explicit type");
      }
      try {
        return await writer.append({ type, ...detail });
      } catch (error) {
        throw new AuditRecordingError(
          `Failed to write audit record "${type}" to ${auditRoot}: ${error.message}`,
          error,
        );
      }
    },
  };
}

/**
 * Reduces a process result to the fields worth retaining. Raw stdout and stderr
 * are excluded: each is capped at 10 MiB, and an audit segment is an integrity
 * record rather than a log sink.
 */
export function summarizeExecutionForAudit(execution = {}) {
  return {
    status: execution.status ?? null,
    ok: execution.ok === true,
    exitCode: execution.exitCode ?? null,
    signal: execution.signal ?? null,
    timedOut: execution.timedOut === true,
    aborted: execution.aborted === true,
    outputExceeded: execution.outputExceeded ?? null,
    ...(execution.error ? { error: { message: execution.error.message, code: execution.error.code ?? null } } : {}),
  };
}
