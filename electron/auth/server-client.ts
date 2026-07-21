import { BUILD_DEFAULT_SERVER_URL } from "../generated/build-config.js";

export type AuthBrokerUser = {
  id: string;
  email: string | null;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  profilePictureUrl: string | null;
};

export type AuthBrokerSessionResponse = {
  sessionToken: string;
  user: AuthBrokerUser;
  expiresAt: number;
  organizationId: string | null;
  featureFlags: string[];
};

export type AuthOrganization = {
  id: string;
  name: string;
};

export type AuthOrganizationFeatureFlags = {
  organizationId: string;
  featureFlags: string[];
};

export type AuthOrganizationsResponse = {
  organizations: AuthOrganization[];
  featureFlagsByOrganization: AuthOrganizationFeatureFlags[];
  organizationId: string | null;
  // Present when validating the session rotated the WorkOS refresh token; the
  // caller must persist this session or the stored one becomes unrefreshable.
  session: AuthBrokerSessionResponse | null;
};

export type DelegatedIntegrationTokenResponse = {
  token: string;
  expiresAt: number;
  scope: "integrations";
  serverBaseUrl: string;
  // Present when validating the session rotated the WorkOS refresh token; the
  // caller must persist this session or the stored one becomes unrefreshable.
  session: AuthBrokerSessionResponse | null;
};

type ServerDelegatedIntegrationTokenResponse = Omit<DelegatedIntegrationTokenResponse, "serverBaseUrl">;

export type AuthServerClientOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

export type AuthServerHealthOptions = {
  timeoutMs?: number;
};

export type AuthServerHealthResult = {
  readonly reachable: boolean;
  readonly reason: "ok" | "offline" | "dns_failure" | "timeout" | "server_error" | "network_error";
  readonly message: string;
  readonly httpStatus?: number | null;
};

export class AuthServerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage?: string,
  ) {
    super(typeof serverMessage === "string" ? `Server request failed: ${serverMessage}` : `Server request failed: ${status}`);
    this.name = "AuthServerRequestError";
  }
}

export class AuthServerTimeoutError extends Error {
  readonly _tag = "AuthServerTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`Ambient auth server request timed out after ${timeoutMs} ms.`);
    this.name = "AuthServerTimeoutError";
  }
}

export type BridgeAuthCallback =
  | { kind: "success"; ticket: string; clientState: string }
  | { kind: "error"; error: string; errorDescription?: string; clientState: string };

export const BRIDGE_RETURN_URI = "ambient-bridge://auth/callback";
// Baked at build time by scripts/generate-build-config.mjs. Every standard
// release channel defaults to production; deliberate staging/local builds use
// the explicit build-time override. There is no runtime server-URL override, so
// a shipped app can never be pointed at an arbitrary URL.
const DEFAULT_SERVER_URL = BUILD_DEFAULT_SERVER_URL;

export class AuthServerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: AuthServerClientOptions) {
    this.baseUrl = normalizeAuthServerBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  createLoginUrl(clientState: string, returnUri = BRIDGE_RETURN_URI, organizationId?: string): string {
    return createAuthLoginUrl({
      baseUrl: this.baseUrl,
      clientState,
      returnUri,
      organizationId,
    });
  }

  redeemTicket(ticket: string): Promise<AuthBrokerSessionResponse> {
    return this.postJson("/auth/redeem", { ticket }, parseSessionResponse);
  }

  validateSession(
    sessionToken: string,
    options: { readonly forceRefresh?: boolean; readonly organizationId?: string } = {},
  ): Promise<AuthBrokerSessionResponse> {
    return this.postJson("/auth/session", {
      ...(options.forceRefresh ? { forceRefresh: true } : {}),
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      sessionToken,
    }, parseSessionResponse);
  }

  switchOrganization(sessionToken: string, organizationId: string): Promise<AuthBrokerSessionResponse> {
    return this.validateSession(sessionToken, { organizationId });
  }

  listOrganizations(
    sessionToken: string,
    options: { readonly includeFeatureFlags?: boolean } = {},
  ): Promise<AuthOrganizationsResponse> {
    return this.postJson(
      "/auth/organizations",
      {
        ...(options.includeFeatureFlags ? { includeFeatureFlags: true } : {}),
        sessionToken,
      },
      parseOrganizationsResponse,
    );
  }

  async createIntegrationToken(sessionToken: string): Promise<DelegatedIntegrationTokenResponse> {
    const delegated = await this.postJson(
      "/auth/delegate",
      { scope: "integrations", sessionToken },
      parseDelegatedIntegrationTokenResponse,
    );
    return { ...delegated, serverBaseUrl: this.baseUrl };
  }

  async checkHealth(options: AuthServerHealthOptions = {}): Promise<boolean> {
    return (await this.checkHealthDetailed(options)).reachable;
  }

  async checkHealthDetailed(options: AuthServerHealthOptions = {}): Promise<AuthServerHealthResult> {
    const timeoutMs = options.timeoutMs ?? 2_500;
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(new URL("/healthz", this.baseUrl), {
        headers: { Accept: "application/json" },
        method: "GET",
        signal: controller.signal,
      });
      if (response.ok) {
        return {
          httpStatus: response.status,
          message: "Ambient server is reachable.",
          reachable: true,
          reason: "ok",
        };
      }
      return {
        httpStatus: response.status,
        message: `Ambient server health check returned HTTP ${response.status}.`,
        reachable: false,
        reason: "server_error",
      };
    } catch (error) {
      return healthResultFromError(error);
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  async createLogoutUrl(sessionToken: string): Promise<string> {
    const body = await this.postJson("/auth/logout", { sessionToken }, asRecord);
    const logoutUrl = body.logoutUrl;
    if (typeof logoutUrl !== "string") {
      throw new Error("Server logout response was incomplete.");
    }
    return logoutUrl;
  }

  private async postJson<T>(
    path: string,
    body: Record<string, unknown>,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: timeoutSignal,
      });
    } catch (error) {
      if (timeoutSignal.aborted || isAbortError(error) || isTimeoutError(error)) {
        throw new AuthServerTimeoutError(this.requestTimeoutMs);
      }
      throw error;
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch (error) {
      if (timeoutSignal.aborted || isTimeoutError(error)) {
        throw new AuthServerTimeoutError(this.requestTimeoutMs);
      }
      responseBody = {};
    }
    if (!response.ok) {
      const message = asRecord(responseBody).error;
      throw new AuthServerRequestError(response.status, typeof message === "string" ? message : undefined);
    }

    return parse(responseBody);
  }
}

export function resolveServerBaseUrl(): string {
  return normalizeAuthServerBaseUrl(DEFAULT_SERVER_URL);
}

export function createAuthLoginUrl(input: {
  baseUrl: string;
  returnUri: string;
  clientState: string;
  organizationId?: string;
}): string {
  const url = new URL("/auth/login", normalizeAuthServerBaseUrl(input.baseUrl));
  url.searchParams.set("return_uri", input.returnUri);
  url.searchParams.set("client_state", input.clientState);
  if (input.organizationId) {
    url.searchParams.set("organization_id", input.organizationId);
  }
  return url.toString();
}

export function normalizeAuthServerBaseUrl(rawValue: string): string {
  const url = new URL(rawValue);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function healthResultFromError(error: unknown): AuthServerHealthResult {
  if (isAbortError(error)) {
    return {
      message: "Ambient server health check timed out.",
      reachable: false,
      reason: "timeout",
    };
  }

  const code = errorCode(error);
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH" || code === "ENETDOWN") {
    return {
      message: "No internet route is available for Ambient Bridge.",
      reachable: false,
      reason: "offline",
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      message: "DNS lookup for the Ambient server failed.",
      reachable: false,
      reason: "dns_failure",
    };
  }
  if (code === "ETIMEDOUT") {
    return {
      message: "Ambient server health check timed out.",
      reachable: false,
      reason: "timeout",
    };
  }

  return {
    message: "Ambient Bridge could not reach the Ambient server.",
    reachable: false,
    reason: "network_error",
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function errorCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== "object" || depth > 4) return null;
  const record = error as { readonly code?: unknown; readonly cause?: unknown };
  if (typeof record.code === "string" && record.code) return record.code;
  return errorCode(record.cause, depth + 1);
}

export function parseBridgeAuthCallback(rawValue: string, expectedClientState?: string): BridgeAuthCallback {
  const url = new URL(rawValue);
  if (url.protocol !== "ambient-bridge:" || url.hostname !== "auth" || url.pathname !== "/callback") {
    throw new Error("Invalid Bridge auth callback URL.");
  }

  const clientState = url.searchParams.get("client_state") ?? "";
  if (!clientState) {
    throw new Error("Bridge auth callback is missing client state.");
  }
  if (expectedClientState && clientState !== expectedClientState) {
    throw new Error("Bridge auth callback state did not match the pending login.");
  }

  const error = url.searchParams.get("error");
  if (error) {
    return {
      clientState,
      error,
      errorDescription: url.searchParams.get("error_description") ?? undefined,
      kind: "error",
    };
  }

  const ticket = url.searchParams.get("ticket");
  if (!ticket) {
    throw new Error("Bridge auth callback is missing an auth ticket.");
  }
  return { clientState, kind: "success", ticket };
}

function parseSessionResponse(value: unknown): AuthBrokerSessionResponse {
  const body = asRecord(value);
  const sessionToken = body.sessionToken;
  const expiresAt = body.expiresAt;
  return {
    expiresAt: expectNumber(expiresAt, "expiresAt"),
    featureFlags: parseFeatureFlagSlugs(body.featureFlags),
    organizationId: expectOptionalNullableString(body.organizationId),
    sessionToken: expectString(sessionToken, "sessionToken"),
    user: parseUser(body.user),
  };
}

function parseDelegatedIntegrationTokenResponse(value: unknown): ServerDelegatedIntegrationTokenResponse {
  const body = asRecord(value);
  const scope = expectString(body.scope, "scope");
  if (scope !== "integrations") {
    throw new Error("Server response returned an unsupported delegated token scope.");
  }
  return {
    expiresAt: expectNumber(body.expiresAt, "expiresAt"),
    scope,
    session: body.session ? parseSessionResponse(body.session) : null,
    token: expectString(body.token, "token"),
  };
}

function parseUser(value: unknown): AuthBrokerUser {
  const body = asRecord(value);
  return {
    email: expectNullableString(body.email, "user.email"),
    id: expectString(body.id, "user.id"),
    name: expectNullableString(body.name, "user.name"),
    firstName: expectOptionalNullableString(body.firstName),
    lastName: expectOptionalNullableString(body.lastName),
    profilePictureUrl: expectOptionalNullableString(body.profilePictureUrl),
  };
}

function parseOrganizationsResponse(value: unknown): AuthOrganizationsResponse {
  const body = asRecord(value);
  const rawList = Array.isArray(body.organizations) ? body.organizations : [];
  const organizations: AuthOrganization[] = [];
  for (const entry of rawList) {
    const organization = asRecord(entry);
    const id = typeof organization.id === "string" && organization.id ? organization.id : null;
    if (!id) continue;
    const name = typeof organization.name === "string" && organization.name ? organization.name : id;
    organizations.push({ id, name });
  }
  return {
    featureFlagsByOrganization: parseFeatureFlagsByOrganization(body.featureFlagsByOrganization),
    organizations,
    organizationId: expectOptionalNullableString(body.organizationId),
    session: body.session ? parseSessionResponse(body.session) : null,
  };
}

function parseFeatureFlagsByOrganization(value: unknown): AuthOrganizationFeatureFlags[] {
  if (!Array.isArray(value)) return [];
  const entries: AuthOrganizationFeatureFlags[] = [];
  for (const item of value) {
    const entry = asRecord(item);
    const organizationId = typeof entry.organizationId === "string" && entry.organizationId
      ? entry.organizationId
      : null;
    if (!organizationId) continue;
    entries.push({
      featureFlags: parseFeatureFlagSlugs(entry.featureFlags),
      organizationId,
    });
  }
  return entries.sort((a, b) => a.organizationId.localeCompare(b.organizationId));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseFeatureFlagSlugs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((slug): slug is string => typeof slug === "string" && slug.trim().length > 0))]
    .sort();
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Server response was missing ${field}.`);
  }
  return value;
}

function expectNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`Server response was missing ${field}.`);
  }
  return value;
}

function expectOptionalNullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  return value;
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Server response was missing ${field}.`);
  }
  return value;
}
