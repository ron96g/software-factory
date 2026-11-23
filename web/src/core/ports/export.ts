/**
 * ADR-0080 §13: the export contract — the one interface where data flows **into** the factory from a runtime. A runtime
 * exports a git bundle; a factory-owned bare mirror ingests it. Everything inside the bundle is untrusted input: the
 * factory never checks it out, never runs the incoming config/hooks/filters, and reads trees, blobs and diffs through
 * plumbing only.
 */
/** The result of ingesting an exported bundle. */
export interface CandidateExport {
  /** The exported commit (a full object id). */
  commit: string;
  /** The ref the commit was ingested as inside the mirror. */
  ref: string;
  /** The ref the runtime exported. */
  exportedRef: string;
  objects: number;
  refs: number;
  bytes: number;
}

/** Explicit limits on the incoming pack, object count and ref count (ADR-0080 §13). */
export interface ExportLimits {
  maxBytes: number;
  maxObjects: number;
  maxRefs: number;
}

export const DEFAULT_EXPORT_LIMITS: ExportLimits = { maxBytes: 512 * 1024 * 1024, maxObjects: 200_000, maxRefs: 64 };

export interface ExportIngestInput {
  /** An untrusted git bundle produced by the runtime. */
  bundlePath: string;
  /** A factory-owned **bare** mirror to ingest into (created if absent). Never a working tree. */
  mirrorPath: string;
  /** The ref to ingest; defaults to the bundle's first head. */
  ref?: string;
  /** The ref name to store it under inside the mirror. */
  intoRef?: string;
  limits?: Partial<ExportLimits>;
}

/** Ingests an untrusted git bundle into a factory-owned bare mirror (ADR-0080 §13). */
export interface ExportIngestor {
  ingest(input: ExportIngestInput): Promise<CandidateExport>;
}

/**
 * ADR-0080 §13: reads a candidate commit the factory ingested, **through plumbing only** — never a checkout, never a
 * working tree it runs anything in. The mirror is factory-owned and bare.
 */
export interface CandidateDiffer {
  diff(input: { mirrorPath: string; base: string; candidate: string }): Promise<string>;
}

/** A refused export, with a machine-readable reason for the audit record. */
export class ExportRejectedError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}
