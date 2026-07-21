export type WorkOsOrganization = {
  id: string;
  name: string;
};

export type WorkOsFeatureFlagsByOrganization = Record<string, readonly string[]>;

export type WorkOsSession =
  | { kind: "signed_out" }
  | {
      kind: "signed_in";
      sessionToken: string;
      expiresAt: number;
      user: {
        id: string;
        email: string | null;
        name: string | null;
        firstName?: string | null;
        lastName?: string | null;
        profilePictureUrl?: string | null;
      };
      email: string;
      organizationId?: string | null;
      organizationName?: string;
      organizations?: WorkOsOrganization[];
      featureFlags?: string[];
      featureFlagsByOrganization?: WorkOsFeatureFlagsByOrganization;
    };

export type SignedInWorkOsSession = Extract<WorkOsSession, { kind: "signed_in" }>;

export const WORKOS_SESSION_REFRESH_SKEW_SECONDS = 5 * 60;

export function shouldRefreshWorkOsSession(
  session: SignedInWorkOsSession,
  nowMs = Date.now(),
  skewSeconds = WORKOS_SESSION_REFRESH_SKEW_SECONDS,
): boolean {
  const expiresAtMs = session.expiresAt * 1_000;
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs + skewSeconds * 1_000;
}

export function publicSession(session: WorkOsSession) {
  if (session.kind === "signed_out") {
    return session;
  }

  return {
    email: session.email,
    expiresAt: session.expiresAt,
    kind: session.kind,
    organizationId: session.organizationId,
    organizationName: session.organizationName,
  };
}
