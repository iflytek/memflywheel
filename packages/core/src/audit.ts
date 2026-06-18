/**
 * Append-only audit trail. Records are JSONL appended to "<root>/.audit.log".
 * Never contains raw secret material.
 */

import path from "node:path";

import { appendFileLine } from "./atomic.js";

export const AUDIT_FILE = ".audit.log";

export type AuditAction =
  | "write"
  | "delete"
  | "extract"
  | "dream-apply"
  | "relocate"
  | "archive"
  | "secret-refused";

export interface AuditRecord {
  ts: string;
  action: AuditAction;
  path?: string;
  detail?: string;
}

export interface AuditLogger {
  append(record: AuditRecord): Promise<void>;
}

export function createAuditLogger(root: string): AuditLogger {
  const auditPath = path.join(root, AUDIT_FILE);
  return {
    async append(record: AuditRecord): Promise<void> {
      const line = JSON.stringify(record);
      await appendFileLine(auditPath, line);
    },
  };
}

/** A no-op logger for tests / contexts where auditing is disabled. */
export function createNullAuditLogger(): AuditLogger {
  return {
    async append(): Promise<void> {
      /* no-op */
    },
  };
}
