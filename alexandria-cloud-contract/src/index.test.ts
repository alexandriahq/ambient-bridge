import { describe, expect, it } from "vitest";
import {
  cloudBillingAccountSchema,
  cloudBootstrapResponseSchema,
  cloudIdentityClaimsSchema,
  cloudNodeAssignmentSchema,
  cloudPrincipalSchema,
  cloudUsageSubjectSchema,
} from "./index.js";

describe("Cloud tenancy records", () => {
  it("keeps principal, usage subject, and billing account as separate records", () => {
    expect(cloudPrincipalSchema.parse({
      id: "principal_user_1",
      provider: "workos",
      workosUserId: "user_1",
      status: "active",
    }).workosUserId).toBe("user_1");
    expect(cloudUsageSubjectSchema.parse({
      id: "user_1",
      principalId: "principal_user_1",
      status: "active",
    }).principalId).toBe("principal_user_1");
    expect(cloudBillingAccountSchema.parse({
      id: "user_1",
      ownerKind: "user",
      ownerId: "user_1",
      status: "active",
    }).ownerKind).toBe("user");
  });
});

describe("cloud identity claims", () => {
  it("rejects a token without an installation audience", () => {
    const parsed = cloudIdentityClaimsSchema.safeParse({
      iss: "https://cloud.alexandria.so",
      aud: "",
      sub: "user_1",
      workspaceId: "ws_personal_1",
      workspaceKind: "personal",
      workosOrganizationId: null,
      installationId: "inst_1",
      sessionEpoch: 0,
      entitlements: { inference: true, multiplayer: false, publishing: false, mcp: false },
      billing: {
        mode: "user_metered",
        billingAccountId: "user_1",
        perUserAllowanceMicros: null,
        perUserHardLimitMicros: null,
        overage: "deny",
        pricingVersion: "prices@1",
      },
      iat: 1,
      exp: 2,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("cloud bootstrap", () => {
  it("rejects non-HTTP and URL-credential Node destinations", () => {
    const assignment = {
      assignmentId: "assign_personal_public",
      installationId: "inst_1",
      capabilities: ["multiplayer"],
      inferenceMode: "confidential",
      configurationVersion: 1,
    };
    expect(cloudNodeAssignmentSchema.safeParse({
      ...assignment,
      apiBaseUrl: "ftp://node.example.com",
      audience: "ftp://node.example.com",
    }).success).toBe(false);
    expect(cloudNodeAssignmentSchema.safeParse({
      ...assignment,
      apiBaseUrl: "https://user:password@node.example.com",
      audience: "https://user:password@node.example.com",
    }).success).toBe(false);
  });

  it("binds the API destination to the signed identity audience", () => {
    const parsed = cloudBootstrapResponseSchema.safeParse({
      version: "alexandria-cloud-bootstrap/1",
      status: "ready",
      workspace: { id: "ws_personal_1", kind: "personal", workosOrganizationId: null, status: "active" },
      node: {
        assignmentId: "assign_personal_public",
        installationId: "inst_1",
        apiBaseUrl: "https://wrong.example.com",
        audience: "https://node.example.com",
        capabilities: ["multiplayer"],
        inferenceMode: "confidential",
        configurationVersion: 1,
      },
      entitlements: {
        workspaceId: "ws_personal_1",
        inference: true,
        multiplayer: false,
        publishing: false,
        mcp: false,
      },
      billing: {
        workspaceId: "ws_personal_1",
        mode: "user_metered",
        billingAccountId: "user_1",
        perUserAllowanceMicros: null,
        perUserHardLimitMicros: null,
        overage: "deny",
        pricingVersion: "prices@1",
      },
      identity: {
        tokenType: "Bearer",
        accessToken: "signed-token",
        expiresAt: "2026-08-28T12:05:00.000Z",
        claims: {
          iss: "https://cloud.alexandria.so",
          aud: "https://node.example.com",
          sub: "user_1",
          workspaceId: "ws_personal_1",
          workspaceKind: "personal",
          workosOrganizationId: null,
          installationId: "inst_1",
          sessionEpoch: 0,
          entitlements: { inference: true, multiplayer: false, publishing: false, mcp: false },
          billing: {
            mode: "user_metered",
            billingAccountId: "user_1",
            perUserAllowanceMicros: null,
            perUserHardLimitMicros: null,
            overage: "deny",
            pricingVersion: "prices@1",
          },
          iat: 1,
          exp: 2,
        },
        rotatedSessionToken: null,
      },
    });
    expect(parsed.success).toBe(false);
  });
});
