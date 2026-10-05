import { describe, expect, it } from "vitest";
import {
  shouldRefreshWorkOsSession,
  workOsSessionExpiresAtSeconds,
  type SignedInWorkOsSession,
} from "../electron/workos/session.js";

const session: SignedInWorkOsSession = {
  email: "user@example.test",
  expiresAt: 1_700_000_000,
  kind: "signed_in",
  sessionToken: "sealed_session_test",
  user: { email: "user@example.test", id: "user_test", name: null },
};

describe("WorkOS session refresh policy", () => {
  it("does not refresh healthy sessions", () => {
    expect(shouldRefreshWorkOsSession(session, 1_699_999_000_000, 300)).toBe(false);
  });

  it("refreshes sessions inside the expiry skew", () => {
    expect(shouldRefreshWorkOsSession(session, 1_699_999_800_000, 300)).toBe(true);
  });

  it("refreshes expired sessions", () => {
    expect(shouldRefreshWorkOsSession(session, 1_700_000_001_000, 300)).toBe(true);
  });

  it("refreshes when expiresAt is missing or zero", () => {
    expect(shouldRefreshWorkOsSession({ ...session, expiresAt: 0 }, 1_699_999_000_000, 300)).toBe(true);
    expect(shouldRefreshWorkOsSession({ ...session, expiresAt: Number.NaN }, 1_699_999_000_000, 300)).toBe(true);
  });
});

describe("workOsSessionExpiresAtSeconds", () => {
  it("keeps JWT exp unix seconds", () => {
    expect(workOsSessionExpiresAtSeconds(1_700_000_000)).toBe(1_700_000_000);
  });

  it("folds a millisecond clock so persist never writes Date.now()", () => {
    expect(workOsSessionExpiresAtSeconds(1_700_000_000_000)).toBe(1_700_000_000);
  });

  it("rejects zero and NaN", () => {
    expect(workOsSessionExpiresAtSeconds(0)).toBeNaN();
    expect(workOsSessionExpiresAtSeconds(Number.NaN)).toBeNaN();
  });
});
