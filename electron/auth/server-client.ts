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

export type AuthOrganizationsResponse = {
  organizations: AuthOrganization[];
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
};

export type AuthServerHealthOptions = {
  timeoutMs?: number;
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

export type BridgeAuthCallback =
  | { kind: "success"; ticket: string; clientState: string }
  | { kind: "error"; error: string; errorDescription?: string; clientState: string };

export const BRIDGE_RETURN_URI = "ambient-bridge://auth/callback";
const DEFAULT_SERVER_URL = "https://api.alexandria.so";

export class AuthServerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AuthServerClientOptions) {
    this.baseUrl = normalizeAuthServerBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
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

  listOrganizations(sessionToken: string): Promise<AuthOrganizationsResponse> {
    return this.postJson("/auth/organizations", { sessionToken }, parseOrganizationsResponse);
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
    const timeoutMs = options.timeoutMs ?? 2_500;
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(new URL("/healthz", this.baseUrl), {
        headers: { Accept: "application/json" },
        method: "GET",
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
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
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = asRecord(responseBody).error;
      throw new AuthServerRequestError(response.status, typeof message === "string" ? message : undefined);
    }

    return parse(responseBody);
  }
}

export function serverBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeAuthServerBaseUrl(env.AMBIENT_SERVER_URL ?? env.AMBIENT_AUTH_SERVER_URL ?? DEFAULT_SERVER_URL);
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
    organizations,
    organizationId: expectOptionalNullableString(body.organizationId),
    session: body.session ? parseSessionResponse(body.session) : null,
  };
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
