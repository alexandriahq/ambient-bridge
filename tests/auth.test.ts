import { describe, expect, it } from "vitest";
import {
  ReplayCache,
  signLocalRequest,
  verifyLocalRequest,
  type LocalCredential,
} from "../electron/ipc-server/auth.js";
import type { BridgeRequestAuth } from "../electron/ipc-server/protocol.js";

describe("local IPC auth", () => {
  const credential: LocalCredential = {
    id: "cred_1",
    secret: "local-secret",
  };

  it("accepts a signed request once", () => {
    const replayCache = new ReplayCache();
    const payload = { prompt: "hello" };
    const auth = signLocalRequest({
      credential,
      method: "inference.responses",
      nonce: "nonce-1",
      payload,
      timestamp: 1_700_000_000_000,
    });

    expect(
      verifyLocalRequest({
        auth,
        credential,
        method: "inference.responses",
        now: 1_700_000_000_100,
        payload,
        replayCache,
      }),
    ).toEqual({ ok: true, credentialId: "cred_1" });

    expect(
      verifyLocalRequest({
        auth,
        credential,
        method: "inference.responses",
        now: 1_700_000_000_200,
        payload,
        replayCache,
      }),
    ).toEqual({ ok: false, reason: "replayed_nonce" });
  });

  it("rejects a tampered body hash", () => {
    const auth = signLocalRequest({
      credential,
      method: "inference.responses",
      nonce: "nonce-2",
      payload: { prompt: "hello" },
      timestamp: 1_700_000_000_000,
    });

    expect(
      verifyLocalRequest({
        auth,
        credential,
        method: "inference.responses",
        now: 1_700_000_000_100,
        payload: { prompt: "different" },
        replayCache: new ReplayCache(),
      }),
    ).toEqual({ ok: false, reason: "body_hash_mismatch" });
  });

  it("rejects malformed signatures as auth failures", () => {
    const auth = {
      ...signLocalRequest({
        credential,
        method: "inference.responses",
        nonce: "nonce-3",
        payload: { prompt: "hello" },
        timestamp: 1_700_000_000_000,
      }),
      signature: 123,
    } as unknown as BridgeRequestAuth;

    expect(
      verifyLocalRequest({
        auth,
        credential,
        method: "inference.responses",
        now: 1_700_000_000_100,
        payload: { prompt: "hello" },
        replayCache: new ReplayCache(),
      }),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("requires cancellation signatures to target the cancelled request id", () => {
    const payload = { requestId: "req_cancel" };
    const auth = signLocalRequest({
      credential,
      method: "inference.cancel",
      nonce: "nonce-cancel",
      payload,
      timestamp: 1_700_000_000_000,
    });

    expect(
      verifyLocalRequest({
        auth,
        credential,
        method: "inference.cancel",
        now: 1_700_000_000_100,
        payload,
        replayCache: new ReplayCache(),
      }),
    ).toEqual({ ok: true, credentialId: "cred_1" });

    expect(
      verifyLocalRequest({
        auth,
        credential,
        method: "inference.cancel",
        now: 1_700_000_000_100,
        payload: { requestId: "req_other" },
        replayCache: new ReplayCache(),
      }),
    ).toEqual({ ok: false, reason: "body_hash_mismatch" });
  });
});
