export type InferenceModelRole =
  | "chunkAnalysis"
  | "intentLoop"
  | "screenVlm"
  | "stt"
  | "redaction";

export declare const INFERENCE_MODEL_ROLES: readonly InferenceModelRole[];

export interface InferenceModelCatalogEntry {
  readonly id: string;
  readonly label: string;
}

export interface InferenceRoleAssignment {
  readonly modelId: string;
  readonly fallbackModelIds: readonly string[];
}

export interface InferenceModelAssignment {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly roles: {
    readonly chunkAnalysis: InferenceRoleAssignment;
    readonly intentLoop: InferenceRoleAssignment;
    readonly screenVlm: InferenceRoleAssignment;
    readonly stt: InferenceRoleAssignment;
    readonly redaction: InferenceRoleAssignment;
  };
  readonly catalog: {
    readonly chat: readonly InferenceModelCatalogEntry[];
    readonly stt: readonly InferenceModelCatalogEntry[];
  };
  readonly sunsetRemaps: Readonly<Record<string, string>>;
  readonly unavailableModelIds: readonly string[];
}

export type InferenceModelsSnapshot =
  | {
      readonly state: "ready";
      readonly source: "server";
      readonly assignment: InferenceModelAssignment;
      readonly fetchedAt: string;
    }
  | {
      readonly state: "stale";
      readonly source: "server";
      readonly assignment: InferenceModelAssignment;
      readonly fetchedAt: string;
    }
  | {
      readonly state: "offline_default";
      readonly source: "baked";
      readonly assignment: InferenceModelAssignment;
      readonly fetchedAt: null;
      readonly reason: "signed_out" | "offline" | "server_error";
    };

export declare const DEFAULT_INFERENCE_MODEL_ASSIGNMENT: InferenceModelAssignment;

export declare const inferenceModelAssignmentSchema: {
  parse(value: unknown): InferenceModelAssignment;
  safeParse(value: unknown): { success: true; data: InferenceModelAssignment } | { success: false; error: unknown };
};

export declare const inferenceModelsSnapshotSchema: {
  parse(value: unknown): InferenceModelsSnapshot;
  safeParse(value: unknown): { success: true; data: InferenceModelsSnapshot } | { success: false; error: unknown };
};

export function parseInferenceModelAssignment(value: unknown): InferenceModelAssignment;
export function parseInferenceModelsSnapshot(value: unknown): InferenceModelsSnapshot;
export function defaultInferenceModelAssignment(): InferenceModelAssignment;
export function resolveInferenceRoleModel(
  assignment: InferenceModelAssignment,
  role: InferenceModelRole,
): string;
export function remapInferenceChatModel(
  assignment: InferenceModelAssignment,
  modelId: string,
): string;
export function catalogLabelForModel(
  assignment: InferenceModelAssignment,
  modelId: string,
): string;
