import { describe, expect, test } from "vitest";
import { DEFAULT_INFERENCE_MODEL_ASSIGNMENT } from "@ambient/shared/inference-models";
import { AuthServerRequestError, AuthServerTimeoutError } from "../auth/server-client.js";
import type { SignedInWorkOsSession } from "../workos/session.js";
import { BridgeModelAssignmentCache } from "./model-assignment-cache.js";

const session: SignedInWorkOsSession = {
  kind: "signed_in",
  sessionToken: "session_test",
  expiresAt: Math.floor(Date.now() / 1000) + 3_600,
  user: { id: "user_a", email: "a@example.com", name: "A" },
  email: "a@example.com",
  organizationId: "org_a",
  featureFlags: [],
};

describe("BridgeModelAssignmentCache", () => {
  test("returns the offline bake when signed out", async () => {
    const cache = new BridgeModelAssignmentCache();
    const snapshot = await cache.read({
      session: null,
      load: async () => {
        throw new Error("should not load");
      },
    });
    expect(snapshot.state).toBe("offline_default");
    if (snapshot.state !== "offline_default") return;
    expect(snapshot.reason).toBe("signed_out");
    expect(snapshot.assignment.roles.stt.modelId).toBe("whisper-large-v3-turbo");
  });

  test("caches a successful server assignment", async () => {
    let loads = 0;
    const cache = new BridgeModelAssignmentCache(60_000, () => 1_000);
    const first = await cache.read({
      session,
      load: async () => {
        loads += 1;
        return {
          ...DEFAULT_INFERENCE_MODEL_ASSIGNMENT,
          version: "server-v1",
        };
      },
    });
    const second = await cache.read({
      session,
      load: async () => {
        loads += 1;
        throw new Error("should use cache");
      },
    });
    expect(first).toMatchObject({ state: "ready", assignment: { version: "server-v1" } });
    expect(second.state).toBe("ready");
    expect(loads).toBe(1);
  });

  test("returns stale assignment after a later network failure", async () => {
    let now = 1_000;
    const cache = new BridgeModelAssignmentCache(1, () => now);
    await cache.read({
      session,
      load: async () => ({
        ...DEFAULT_INFERENCE_MODEL_ASSIGNMENT,
        version: "server-v1",
      }),
    });
    now = 5_000;
    const stale = await cache.read({
      session,
      force: true,
      load: async () => {
        throw new AuthServerTimeoutError(1_000);
      },
    });
    expect(stale).toMatchObject({
      state: "stale",
      assignment: { version: "server-v1" },
    });
  });

  test("falls back to the bake after an auth failure with no cache", async () => {
    const cache = new BridgeModelAssignmentCache();
    const snapshot = await cache.read({
      session,
      load: async () => {
        throw new AuthServerRequestError(401, "nope");
      },
    });
    expect(snapshot).toMatchObject({
      state: "offline_default",
      reason: "signed_out",
      source: "baked",
    });
  });
});
