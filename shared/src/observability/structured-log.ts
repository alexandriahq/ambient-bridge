export type StructuredLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

/** Canonical JSONL record written by Ambient products. */
export type StructuredLogRecord<
  Annotations extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly ts: string;
  readonly level: string;
  readonly service: string;
  readonly component: string;
  readonly pid: number;
  readonly threadId: number;
  readonly processType: string;
  readonly message: string;
  readonly annotations: Annotations;
};
