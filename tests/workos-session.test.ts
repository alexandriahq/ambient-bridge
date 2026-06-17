import { describe, expect, it } from "vitest";
import { shouldRefreshWorkOsSession, type SignedInWorkOsSession } from "../electron/workos/session.js";

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
});
