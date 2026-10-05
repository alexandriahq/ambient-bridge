import { describe, expect, it } from "vitest";
import { PairingStore } from "../electron/ipc-server/pairing.js";

describe("PairingStore", () => {
  it("keeps pending requests until Bridge approves them", () => {
    const store = new PairingStore();

    const request = store.start("Ambient App", 1_700_000_000_000);

    expect(store.resultForRequest(request.id)).toEqual({
      request,
      status: "pending",
    });

    const client = store.complete(request.id, true, 1_700_000_000_100);

    expect(client).toBeDefined();
    expect(store.resultForRequest(request.id)).toMatchObject({
      client: {
        id: client?.id,
        name: "Ambient App",
      },
      request: {
        clientId: client?.id,
        status: "approved",
      },
      status: "approved",
    });
  });

  it("restores clients, credentials, requests, and revocation from a snapshot", () => {
    const store = new PairingStore();
    const request = store.start("Ambient App", 1_700_000_000_000);
    const client = store.complete(request.id, true, 1_700_000_000_100);
    if (!client) throw new Error("pairing approval failed");
    store.revoke(client.id, 1_700_000_000_200);

    const restored = PairingStore.fromSnapshot(store.snapshot());

    expect(restored.findCredential(client.credential.id)).toEqual({
      id: client.credential.id,
      revokedAt: 1_700_000_000_200,
      secret: client.credential.secret,
    });
    expect(restored.listRequests()).toEqual(store.listRequests());
    expect(restored.listClients()).toEqual(store.listClients());
  });

  it("refuses a future pairing snapshot so an old Bridge fails closed", () => {
    expect(() => PairingStore.fromSnapshot({
      schemaVersion: 2,
      requests: [],
      clients: [],
    })).toThrow(/schemaVersion 2 is newer than this Bridge/);
  });
});
