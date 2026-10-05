import { randomBytes, randomUUID } from "node:crypto";
import type { LocalCredential } from "./auth.js";

export type PairingStatus = "pending" | "approved" | "rejected";

export type PairingRequest = {
  id: string;
  clientName: string;
  requestedAt: number;
  status: PairingStatus;
  clientId?: string;
  completedAt?: number;
};

export type PairedClient = {
  id: string;
  name: string;
  credential: LocalCredential;
  pairedAt: number;
};

export type PairingResult =
  | { status: "unknown" }
  | { status: "pending"; request: PairingRequest }
  | { status: "rejected"; request: PairingRequest }
  | { status: "approved"; request: PairingRequest; client: PairedClient };

export type PairingStoreSnapshot = {
  schemaVersion: 1;
  requests: PairingRequest[];
  clients: PairedClient[];
};

const PENDING_PAIRING_REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PAIRING_REQUESTS = 100;
const MAX_PAIRED_CLIENTS = 50;

export class PairingStore {
  private readonly requests = new Map<string, PairingRequest>();
  private readonly clients = new Map<string, PairedClient>();

  static fromSnapshot(snapshot: unknown): PairingStore {
    const store = new PairingStore();
    const body = snapshot && typeof snapshot === "object" ? snapshot as Record<string, unknown> : {};
    const schemaVersion = body.schemaVersion;
    if (typeof schemaVersion === "number" && Number.isInteger(schemaVersion) && schemaVersion > 1) {
      throw new Error(
        `Pairing snapshot schemaVersion ${schemaVersion} is newer than this Bridge (speaks 1).`,
      );
    }
    const requests = Array.isArray(body.requests) ? body.requests : [];
    const clients = Array.isArray(body.clients) ? body.clients : [];

    for (const request of requests) {
      const parsed = parsePairingRequest(request);
      if (parsed) {
        store.requests.set(parsed.id, parsed);
      }
    }

    for (const client of clients) {
      const parsed = parsePairedClient(client);
      if (parsed) {
        store.clients.set(parsed.id, parsed);
      }
    }

    return store;
  }

  start(clientName: string, now = Date.now()): PairingRequest {
    this.pruneStalePendingRequests(now);
    const request: PairingRequest = {
      clientName,
      id: randomUUID(),
      requestedAt: now,
      status: "pending",
    };
    this.requests.set(request.id, request);
    this.prunePendingRequestsToLimit();
    return request;
  }

  complete(requestId: string, approved: boolean, now = Date.now()): PairedClient | undefined {
    this.pruneStalePendingRequests(now);
    const request = this.requests.get(requestId);
    if (!request || request.status !== "pending") {
      return undefined;
    }

    request.status = approved ? "approved" : "rejected";
    request.completedAt = now;
    if (!approved) {
      return undefined;
    }

    const client: PairedClient = {
      credential: {
        id: randomUUID(),
        secret: randomBytes(32).toString("base64url"),
      },
      id: randomUUID(),
      name: request.clientName,
      pairedAt: now,
    };
    request.clientId = client.id;
    this.clients.set(client.id, client);
    this.pruneClientsToLimit(client.id);
    return client;
  }

  revoke(clientId: string, now = Date.now()): boolean {
    const client = this.clients.get(clientId);
    if (!client) {
      return false;
    }
    client.credential.revokedAt = now;
    this.pruneClientsToLimit();
    return true;
  }

  resultForRequest(requestId: string): PairingResult {
    const request = this.requests.get(requestId);
    if (!request) {
      return { status: "unknown" };
    }
    if (request.status === "pending") {
      return { status: "pending", request };
    }
    if (request.status === "rejected") {
      return { status: "rejected", request };
    }

    const client = request.clientId ? this.clients.get(request.clientId) : undefined;
    return client
      ? { status: "approved", request, client }
      : { status: "unknown" };
  }

  findCredential(credentialId: string): LocalCredential | undefined {
    for (const client of this.clients.values()) {
      if (client.credential.id === credentialId) {
        return client.credential;
      }
    }
    return undefined;
  }

  listClients(): PairedClient[] {
    return [...this.clients.values()];
  }

  listRequests(): PairingRequest[] {
    return [...this.requests.values()];
  }

  snapshot(): PairingStoreSnapshot {
    return {
      clients: this.listClients().map((client) => ({
        ...client,
        credential: { ...client.credential },
      })),
      requests: this.listRequests().map((request) => ({ ...request })),
      schemaVersion: 1,
    };
  }

  private pruneStalePendingRequests(now: number): void {
    for (const request of this.requests.values()) {
      if (request.status === "pending" && now - request.requestedAt > PENDING_PAIRING_REQUEST_TTL_MS) {
        this.requests.delete(request.id);
      }
    }
  }

  private prunePendingRequestsToLimit(): void {
    const pending = [...this.requests.values()]
      .filter((request) => request.status === "pending")
      .sort(compareRequestsByRequestedAt);

    while (pending.length > MAX_PENDING_PAIRING_REQUESTS) {
      const request = pending.shift();
      if (!request) return;
      this.requests.delete(request.id);
    }
  }

  private pruneClientsToLimit(protectedClientId?: string): void {
    while (this.clients.size > MAX_PAIRED_CLIENTS) {
      const client = this.clientToEvict(protectedClientId);
      if (!client) return;
      this.clients.delete(client.id);
    }
  }

  private clientToEvict(protectedClientId?: string): PairedClient | undefined {
    const candidates = [...this.clients.values()].filter((client) => client.id !== protectedClientId);
    const revoked = candidates.filter((client) => client.credential.revokedAt !== undefined);
    return oldestClient(revoked) ?? oldestClient(candidates);
  }
}

function compareRequestsByRequestedAt(left: PairingRequest, right: PairingRequest): number {
  return left.requestedAt - right.requestedAt || left.id.localeCompare(right.id);
}

function oldestClient(clients: PairedClient[]): PairedClient | undefined {
  return clients.sort(compareClientsByPairedAt)[0];
}

function compareClientsByPairedAt(left: PairedClient, right: PairedClient): number {
  return left.pairedAt - right.pairedAt || left.id.localeCompare(right.id);
}

function parsePairingRequest(value: unknown): PairingRequest | null {
  const body = record(value);
  const id = stringValue(body.id);
  const clientName = stringValue(body.clientName);
  const requestedAt = numberValue(body.requestedAt);
  const status = pairingStatus(body.status);
  if (!id || !clientName || !requestedAt || !status) return null;
  const request: PairingRequest = {
    clientName,
    id,
    requestedAt,
    status,
  };
  const clientId = stringValue(body.clientId);
  const completedAt = numberValue(body.completedAt);
  if (clientId) request.clientId = clientId;
  if (completedAt) request.completedAt = completedAt;
  return request;
}

function parsePairedClient(value: unknown): PairedClient | null {
  const body = record(value);
  const credential = record(body.credential);
  const id = stringValue(body.id);
  const name = stringValue(body.name);
  const pairedAt = numberValue(body.pairedAt);
  const credentialId = stringValue(credential.id);
  const secret = stringValue(credential.secret);
  if (!id || !name || !pairedAt || !credentialId || !secret) return null;
  const revokedAt = numberValue(credential.revokedAt);
  return {
    credential: {
      id: credentialId,
      secret,
      revokedAt: revokedAt ?? undefined,
    },
    id,
    name,
    pairedAt,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pairingStatus(value: unknown): PairingStatus | null {
  return value === "pending" || value === "approved" || value === "rejected" ? value : null;
}
