import { Context, Data, Effect, Layer, Scope } from "effect";
import * as Schema from "effect/Schema";

export const HarnessKindSchema = Schema.Literal(
  "chunk",
  "intent",
  "handoff_refine",
  "automation",
  "custom"
);
export type HarnessKind = typeof HarnessKindSchema.Type;

export const HarnessThinkingLevelSchema = Schema.Literal(
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
);
export type HarnessThinkingLevel = typeof HarnessThinkingLevelSchema.Type;

export const HarnessNativeToolNameSchema = Schema.Literal(
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "bash"
);
export type HarnessNativeToolName = typeof HarnessNativeToolNameSchema.Type;

export const HarnessNativeToolPolicySchema = Schema.Struct({
  allowed: Schema.Array(HarnessNativeToolNameSchema),
  bash: Schema.Struct({
    enabled: Schema.Boolean,
    reason: Schema.NullOr(Schema.String)
  })
});
export type HarnessNativeToolPolicy = typeof HarnessNativeToolPolicySchema.Type;

export const HarnessJsonSchemaSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown
});
export type HarnessJsonSchema = typeof HarnessJsonSchemaSchema.Type;

export const HarnessHostToolSpecSchema = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  description: Schema.String,
  parametersJsonSchema: HarnessJsonSchemaSchema
});
export type HarnessHostToolSpec = typeof HarnessHostToolSpecSchema.Type;

export const HarnessInlineFileMountSchema = Schema.Struct({
  kind: Schema.Literal("inline_file"),
  targetPath: Schema.String,
  content: Schema.String,
  executable: Schema.Boolean
});

export const HarnessLocalPathMountSchema = Schema.Struct({
  kind: Schema.Literal("local_path"),
  sourcePath: Schema.String,
  targetPath: Schema.String,
  writable: Schema.Boolean
});

export const HarnessWritableMemoryMountSchema = Schema.Struct({
  kind: Schema.Literal("writable_memory"),
  targetPath: Schema.String,
  seedPath: Schema.NullOr(Schema.String)
});

export const HarnessMountSpecSchema = Schema.Union(
  HarnessInlineFileMountSchema,
  HarnessLocalPathMountSchema,
  HarnessWritableMemoryMountSchema
);
export type HarnessMountSpec = typeof HarnessMountSpecSchema.Type;

export const HarnessFinalizerSpecSchema = Schema.Struct({
  toolName: Schema.String,
  description: Schema.String,
  resultJsonSchema: HarnessJsonSchemaSchema
});
export type HarnessFinalizerSpec = typeof HarnessFinalizerSpecSchema.Type;

export const HarnessNetworkPolicySchema = Schema.Struct({
  mode: Schema.Literal("blocked", "allowlist", "unrestricted"),
  allowedEndpoints: Schema.Array(Schema.String)
});
export type HarnessNetworkPolicy = typeof HarnessNetworkPolicySchema.Type;

export const HarnessLocalPiBackendConfigSchema = Schema.Struct({
  backend: Schema.Literal("local-pi"),
  bridgeProviderRequired: Schema.Boolean
});

export const HarnessDaytonaBackendConfigSchema = Schema.Struct({
  backend: Schema.Literal("daytona"),
  snapshot: Schema.String,
  networkPolicy: HarnessNetworkPolicySchema,
  eventMode: Schema.Literal("jsonl", "completion")
});

export const HarnessBackendConfigSchema = Schema.Union(
  HarnessLocalPiBackendConfigSchema,
  HarnessDaytonaBackendConfigSchema
);
export type HarnessBackendConfig = typeof HarnessBackendConfigSchema.Type;

export const HarnessEventSchema = Schema.Struct({
  type: Schema.String,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown)
});
export type HarnessEvent = typeof HarnessEventSchema.Type;

export const HarnessWritableMountFileDiffSchema = Schema.Struct({
  path: Schema.String,
  content: Schema.NullOr(Schema.String),
  deleted: Schema.Boolean
});
export type HarnessWritableMountFileDiff = typeof HarnessWritableMountFileDiffSchema.Type;

export const HarnessWritableMountDiffSchema = Schema.Struct({
  targetPath: Schema.String,
  files: Schema.Array(HarnessWritableMountFileDiffSchema)
});
export type HarnessWritableMountDiff = typeof HarnessWritableMountDiffSchema.Type;

export const HarnessRunWireSpecSchema = Schema.Struct({
  name: Schema.String,
  kind: HarnessKindSchema,
  sessionDirPrefix: Schema.String,
  systemPrompt: Schema.String,
  prompt: Schema.String,
  model: Schema.NullOr(Schema.String),
  thinkingLevel: Schema.NullOr(HarnessThinkingLevelSchema),
  nativeTools: HarnessNativeToolPolicySchema,
  hostTools: Schema.Array(HarnessHostToolSpecSchema),
  mounts: Schema.Array(HarnessMountSpecSchema),
  finalizer: HarnessFinalizerSpecSchema,
  backend: HarnessBackendConfigSchema,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown })
});
export type HarnessRunWireSpec = typeof HarnessRunWireSpecSchema.Type;

export const HarnessRunResultSchema = Schema.Struct({
  finalText: Schema.String,
  finalToolName: Schema.NullOr(Schema.String),
  finalResult: Schema.Unknown,
  events: Schema.Array(HarnessEventSchema),
  mountDiffs: Schema.Array(HarnessWritableMountDiffSchema),
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown })
});
export type HarnessRunResult = typeof HarnessRunResultSchema.Type;

export const HarnessSandboxErrorReasonSchema = Schema.Literal(
  "invalid_spec",
  "unsupported_backend",
  "sandbox_create_failed",
  "sandbox_execute_failed",
  "sandbox_cleanup_failed",
  "tool_execution_failed",
  "finalizer_failed",
  "mount_failed",
  "network_policy_failed"
);
export type HarnessSandboxErrorReason = typeof HarnessSandboxErrorReasonSchema.Type;

export class HarnessSandboxError extends Data.TaggedError("HarnessSandboxError")<{
  readonly reason: HarnessSandboxErrorReason;
  readonly message: string;
  readonly backend: HarnessBackendConfig["backend"] | null;
  readonly cause?: unknown;
}> {}

export interface HarnessHostToolCall {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly params: unknown;
}

export type HarnessHostToolExecutor = (
  call: HarnessHostToolCall
) => Effect.Effect<unknown, HarnessSandboxError> | Promise<unknown> | unknown;

export type HarnessHostToolExecutors = ReadonlyMap<string, HarnessHostToolExecutor>
  | Readonly<Record<string, HarnessHostToolExecutor>>;

export type HarnessResultDecoder<Result = unknown> = (
  value: unknown
) => Effect.Effect<Result, HarnessSandboxError> | Result;

export type HarnessEventSink = (event: HarnessEvent) => void;

export interface HarnessRunSpec extends HarnessRunWireSpec {
  readonly hostToolExecutors: HarnessHostToolExecutors;
  readonly decodeResult?: HarnessResultDecoder;
  readonly eventSink?: HarnessEventSink;
}

export interface HarnessSandboxShape {
  readonly run: (spec: HarnessRunSpec) => Effect.Effect<HarnessRunResult, HarnessSandboxError>;
}

export class HarnessSandbox extends Context.Tag("@ambient/shared/HarnessSandbox")<
  HarnessSandbox,
  HarnessSandboxShape
>() {}

export function runContextPiHarness(
  spec: HarnessRunSpec
): Effect.Effect<HarnessRunResult, HarnessSandboxError, HarnessSandbox> {
  return Effect.flatMap(HarnessSandbox, (sandbox) => sandbox.run(spec));
}

export function HarnessSandboxLive(shape: HarnessSandboxShape): Layer.Layer<HarnessSandbox> {
  return Layer.succeed(HarnessSandbox, HarnessSandbox.of(shape));
}

export function scopedHarnessSandbox(
  runScoped: (spec: HarnessRunSpec) => Effect.Effect<HarnessRunResult, HarnessSandboxError, Scope.Scope>
): HarnessSandboxShape {
  return {
    run: (spec) => Effect.scoped(runScoped(spec))
  };
}

export function validateHarnessRunWireSpec(
  value: unknown
): Effect.Effect<HarnessRunWireSpec, HarnessSandboxError> {
  return Schema.decodeUnknown(HarnessRunWireSpecSchema)(value).pipe(
    Effect.mapError((cause) => new HarnessSandboxError({
      reason: "invalid_spec",
      message: "Harness run spec failed schema validation.",
      backend: null,
      cause
    }))
  );
}

export function validateHarnessRunResult(
  value: unknown,
  backend: HarnessBackendConfig["backend"] | null = null
): Effect.Effect<HarnessRunResult, HarnessSandboxError> {
  return Schema.decodeUnknown(HarnessRunResultSchema)(value).pipe(
    Effect.mapError((cause) => new HarnessSandboxError({
      reason: "finalizer_failed",
      message: "Harness run result failed schema validation.",
      backend,
      cause
    }))
  );
}

export function defaultNativeToolPolicy(
  allowed: readonly HarnessNativeToolName[] = []
): HarnessNativeToolPolicy {
  return {
    allowed: [...allowed],
    bash: {
      enabled: allowed.includes("bash"),
      reason: allowed.includes("bash") ? "explicitly enabled" : null
    }
  };
}

export function emitHarnessEvent(spec: HarnessRunSpec, event: HarnessEvent): void {
  try {
    spec.eventSink?.(event);
  } catch {
    // Harness event subscribers are observational only.
  }
}

export function hostToolExecutor(
  executors: HarnessHostToolExecutors,
  name: string
): HarnessHostToolExecutor | null {
  const mapLike = executors as ReadonlyMap<string, HarnessHostToolExecutor>;
  if (typeof mapLike.get === "function") return mapLike.get(name) ?? null;
  return (executors as Readonly<Record<string, HarnessHostToolExecutor>>)[name] ?? null;
}
