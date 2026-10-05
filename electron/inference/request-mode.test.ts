import { describe, expect, it } from "vitest";
import {
  assertInferencePathAllowedInMode,
  inferenceClientForMode,
  InferenceModeRequestError,
  nodeModeForRequest,
  requestInferenceModeFromPayload,
} from "./request-mode.js";

describe("per-request inference mode (ADR-0313)", () => {
  it("reads and strips inferenceMode so the upstream body is the app's request only", () => {
    expect(requestInferenceModeFromPayload({ model: "gemma-4-31b", input: "hi", inferenceMode: "confidential" }))
      .toEqual({ mode: "confidential", payload: { model: "gemma-4-31b", input: "hi" } });
    expect(requestInferenceModeFromPayload({ model: "baai/bge-m3", inferenceMode: "zero-retention" }))
      .toEqual({ mode: "zero-retention", payload: { model: "baai/bge-m3" } });
    expect(requestInferenceModeFromPayload({ model: "m", inferenceMode: null }))
      .toEqual({ mode: null, payload: { model: "m" } });
  });

  it("treats an absent mode as the assignment's, as released apps send", () => {
    const payload = { model: "gemma-4-31b", mode: "json" };
    expect(requestInferenceModeFromPayload(payload)).toEqual({ mode: null, payload });
    expect(requestInferenceModeFromPayload(undefined)).toEqual({ mode: null, payload: undefined });
    expect(requestInferenceModeFromPayload([1, 2])).toEqual({ mode: null, payload: [1, 2] });
  });

  it("refuses an unknown mode instead of guessing a transport", () => {
    for (const value of ["plaintext", "Confidential", "", 1, true, { mode: "confidential" }]) {
      expect(() => requestInferenceModeFromPayload({ model: "m", inferenceMode: value as never }))
        .toThrow(InferenceModeRequestError);
    }
  });

  it("runs a request in its own mode, else the Node's default", () => {
    expect(nodeModeForRequest("plaintext", null)).toBe("plaintext");
    expect(nodeModeForRequest("confidential", null)).toBe("confidential");
    expect(nodeModeForRequest("plaintext", "confidential")).toBe("confidential");
    expect(nodeModeForRequest("confidential", "zero-retention")).toBe("plaintext");
  });

  it("allows embeddings only in Zero Data Retention", () => {
    expect(() => assertInferencePathAllowedInMode("/v1/embeddings", "confidential")).toThrow(/only in Alexandria Zero Data Retention/);
    expect(() => assertInferencePathAllowedInMode("/v1/embeddings", "plaintext")).not.toThrow();
    expect(() => assertInferencePathAllowedInMode("/v1/chat/completions", "confidential")).not.toThrow();
    expect(() => assertInferencePathAllowedInMode("/v1/audio/transcriptions", "confidential")).not.toThrow();
  });

  it("selects the Tinfoil client for Confidential and the plaintext client otherwise", () => {
    const clients = { cloudNodePlaintext: "plaintext", cloudNodeConfidential: "tinfoil" } as const;
    expect(inferenceClientForMode("confidential", clients)).toBe("tinfoil");
    expect(inferenceClientForMode("plaintext", clients)).toBe("plaintext");
  });
});
