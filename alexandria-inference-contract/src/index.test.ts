import { describe, expect, it } from "vitest";
import {
  generateEd25519KeyPairPem,
  inferenceGrantClaimsSchema,
  inferencePolicySchema,
  inferenceReceiptAcknowledgementSchema,
  inferenceUsageReceiptClaimsSchema,
  openRouterModelRoutes,
  publicJwk,
  resolveBedrockModel,
  signJwt,
  verifyJwt,
} from "./index.js";

describe("inference policy", () => {
  it("requires explicit opt-in for plaintext", () => {
    expect(inferencePolicySchema.safeParse({
      mode: "plaintext",
      exposure: "provider-readable",
      profile: "rollup@1",
      providers: ["openrouter"],
      models: ["model"],
      regions: [],
      retainContent: false,
    }).success).toBe(false);
  });

  it("forbids OpenRouter on confidential grants", () => {
    const parsed = inferenceGrantClaimsSchema.safeParse({
      iss: "https://cloud.alexandria.so",
      aud: "https://inference.alexandria.so",
      sub: "inference-grant",
      jti: "grant_1",
      iat: 10,
      exp: 20,
      requestId: "req_1",
      installationId: "inst_1",
      subjectId: "user_1",
      workspaceId: "ws_personal_1",
      workosOrganizationId: null,
      usageSubjectId: "user_1",
      feature: "scope_rollup",
      route: "chat.completions",
      policy: {
        mode: "confidential",
        minimumAssurance: "attested",
        denyDowngrade: true,
        executors: ["tinfoil"],
        profile: "scope@1",
        providers: ["openrouter"],
        models: ["model"],
        regions: [],
        retainContent: false,
      },
      target: {
        url: "https://inference.alexandria.so/v1/requests",
        executor: "openrouter",
        provider: "openrouter",
        model: "model",
        region: null,
        keySessionRequired: true,
      },
      reservation: { id: "res_1", pricingVersion: "prices@1", maximumChargeMicros: "1" },
      billing: { mode: "user_metered", billingAccountId: "user_1", pricingVersion: "prices@1" },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("inference receipt lifecycle", () => {
  const acceptedReceipt = {
    iss: "https://inference.alexandria.so",
    aud: "https://cloud.alexandria.so",
    sub: "inference-usage-receipt",
    jti: "receipt_accepted_1",
    iat: 10,
    exp: 20,
    grantId: "grant_1",
    requestId: "request_1",
    installationId: "installation_1",
    workspaceId: "workspace_1",
    workosOrganizationId: null,
    usageSubjectId: "user_1",
    reservationId: "reservation_1",
    billing: {
      mode: "user_metered",
      billingAccountId: "user_1",
      pricingVersion: "prices_1",
    },
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    route: "chat.completions",
    mode: "plaintext",
    status: "accepted",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, audioSeconds: null },
    safeErrorCode: null,
  } as const;

  it("accepts only zero-usage, non-terminal provider acceptance events", () => {
    expect(inferenceUsageReceiptClaimsSchema.safeParse(acceptedReceipt).success).toBe(true);
    expect(inferenceUsageReceiptClaimsSchema.safeParse({
      ...acceptedReceipt,
      usage: { ...acceptedReceipt.usage, promptTokens: 1, totalTokens: 1 },
    }).success).toBe(false);
    expect(inferenceUsageReceiptClaimsSchema.safeParse({
      ...acceptedReceipt,
      safeErrorCode: "provider_error",
    }).success).toBe(false);
  });

  it("binds acknowledgements to the lifecycle status and request identifiers", () => {
    expect(inferenceReceiptAcknowledgementSchema.parse({
      receiptId: acceptedReceipt.jti,
      reservationId: acceptedReceipt.reservationId,
      requestId: acceptedReceipt.requestId,
      status: "accepted",
      accepted: true,
    })).toMatchObject({ status: "accepted", accepted: true });
    expect(inferenceReceiptAcknowledgementSchema.parse({
      receiptId: "receipt_terminal_1",
      reservationId: acceptedReceipt.reservationId,
      requestId: acceptedReceipt.requestId,
      status: "succeeded",
      accepted: false,
    })).toMatchObject({ status: "succeeded", accepted: false });
    expect(inferenceReceiptAcknowledgementSchema.safeParse({
      receiptId: acceptedReceipt.jti,
      reservationId: acceptedReceipt.reservationId,
      requestId: acceptedReceipt.requestId,
      status: "succeeded",
      accepted: true,
    }).success).toBe(false);
  });
});

describe("EdDSA JWT", () => {
  it("signs and verifies with an exported JWKS key", () => {
    const pair = generateEd25519KeyPairPem();
    const jwk = publicJwk({ privateKey: pair.privateKey, keyId: "key_1" });
    const token = signJwt({ iss: "issuer", aud: "audience", exp: 200, value: 1 }, {
      privateKey: pair.privateKey,
      keyId: "key_1",
    });
    const verified = verifyJwt(token, (kid) => kid === "key_1" ? jwk : null, {
      audience: "audience",
      issuer: "issuer",
      nowSeconds: 100,
    });
    expect(verified.claims.value).toBe(1);
  });
});

describe("OpenRouter executor models", () => {
  it("lists the routes an id serves and nothing for unknown or inherited keys", () => {
    expect(openRouterModelRoutes("glm-5-3")).toEqual(["/v1/chat/completions", "/v1/responses"]);
    expect(openRouterModelRoutes("whisper-large-v3")).toEqual(["/v1/audio/transcriptions"]);
    expect(openRouterModelRoutes("google.gemma-4-31b")).toEqual([]);
    expect(openRouterModelRoutes("constructor")).toEqual([]);
  });
});

describe("proper catalog ids", () => {
  it("run the same provider models as the ids released desktops send", () => {
    expect(resolveBedrockModel("gemma-4-31b", "responses")?.id).toBe(resolveBedrockModel("gemma4-31b", "responses")?.id);
    expect(resolveBedrockModel("glm-5", "chat.completions")?.id).toBe("zai.glm-5");
    expect(resolveBedrockModel("qwen3-32b", "chat.completions")?.id).toBe("qwen.qwen3-32b");
    expect(resolveBedrockModel("qwen3-32b", "responses")).toBeNull();
    expect(openRouterModelRoutes("gemma-4-31b")).toEqual(openRouterModelRoutes("gemma4-31b"));
    expect(openRouterModelRoutes("glm-5")).toEqual([]);
  });
});
