export type FeatureFlagKey =
  | "integrations"
  | "automations"
  | "automationToggleTrack"
  | "devtooling"
  | "contextHandoff"
  | "skills"
  | "reports";

export type FeatureFlagFamily = "integrations" | "automations" | "devtools" | "context";

export type FeatureFlagDefinition = {
  readonly key: FeatureFlagKey;
  readonly slug: string;
  readonly title: string;
  readonly family: FeatureFlagFamily;
  readonly description: string;
  readonly requiresKey?: FeatureFlagKey;
};

export type FeatureFlagCapabilities = Record<FeatureFlagKey, boolean>;

export const AMBIENT_FEATURE_FLAG_DEFINITIONS: readonly FeatureFlagDefinition[] = [
  {
    key: "integrations",
    slug: "integrations-enabled",
    title: "Integrations",
    family: "integrations",
    description: "Shows and enables the integrations area in general.",
  },
  {
    key: "automations",
    slug: "automations-enabled",
    title: "Automations",
    family: "automations",
    description: "Shows and enables the automations area in general.",
  },
  {
    key: "automationToggleTrack",
    slug: "automations-toggle-track-available",
    title: "Toggle Track automation",
    family: "automations",
    description: "Enables the specific Toggle Track automation capability.",
    requiresKey: "automations",
  },
  {
    key: "devtooling",
    slug: "devtools-visible",
    title: "Dev tooling",
    family: "devtools",
    description: "Shows internal and developer-only tooling.",
  },
  {
    key: "contextHandoff",
    slug: "enable-agents",
    title: "Agents",
    family: "context",
    description: "Enables Agents, suggested tasks, and new agent execution.",
  },
  {
    key: "skills",
    slug: "enable-skills",
    title: "Skills",
    family: "context",
    description: "Enables the Skills library, drafting, and skill-assisted plans.",
  },
  {
    key: "reports",
    slug: "enable-reports",
    title: "Reports",
    family: "context",
    description: "Enables Reports, report preparation, notifications, and sharing.",
  },
];

// Canonical slugs also work with an older Bridge that forwards unknown flags
// but still sends its old contextHandoff capability. Never let that legacy
// capability or the retired activity-only slug override these independent gates.
export function assistantFeatureCapabilities(enabledSlugs: readonly string[]): Pick<FeatureFlagCapabilities, "contextHandoff" | "skills" | "reports"> {
  const enabled = new Set(enabledSlugs);
  return {
    contextHandoff: enabled.has("enable-agents"),
    skills: enabled.has("enable-skills"),
    reports: enabled.has("enable-reports"),
  };
}

// Preserve raw slug spelling and whitespace; only blank entries are discarded.
export function sanitizeFeatureFlagSlugs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((slug): slug is string => typeof slug === "string" && slug.trim().length > 0))]
    .sort();
}

/** Presentation-only flag, read from raw slugs for older Bridge compatibility. */
export const SHOW_MODEL_DETAILS_FLAG = "show-model-details";
export function modelDetailsVisible(account: {
  readonly kind: string;
  readonly organizationId?: string | null;
  readonly featureFlags?: {
    readonly source?: string;
    readonly enabledSlugs: readonly string[];
    readonly evaluatedFor: { readonly organizationId: string | null };
  };
} | null | undefined): boolean {
  return account?.kind === "signed_in"
    && account.featureFlags?.evaluatedFor.organizationId === (account.organizationId ?? null)
    && account.featureFlags?.enabledSlugs.includes(SHOW_MODEL_DETAILS_FLAG) === true;
}

/** Opt-out default only for a currently evaluated, nonempty organization. */
export const TEXT_REDACTION_DEFAULT_OFF_FLAG = "text-redaction-default-off";
export function textRedactionDefaultEnabled(account: Parameters<typeof modelDetailsVisible>[0]): boolean {
  return !(account?.kind === "signed_in"
    && !!account.organizationId
    && account.featureFlags?.source === "organization"
    && account.featureFlags.evaluatedFor.organizationId === account.organizationId
    && account.featureFlags.enabledSlugs.includes(TEXT_REDACTION_DEFAULT_OFF_FLAG));
}

/** Explicit organization opt-in; unknown focus is never a default. */
export const KEYBOARD_CAPTURE_ALLOW_UNKNOWN_FLAG = "keyboard-capture-allow-unknown";
export function keyboardCaptureAllowUnknown(account: Parameters<typeof modelDetailsVisible>[0]): boolean {
  return account?.kind === "signed_in"
    && !!account.organizationId
    && account.featureFlags?.source === "organization"
    && account.featureFlags.evaluatedFor.organizationId === account.organizationId
    && account.featureFlags.enabledSlugs.includes(KEYBOARD_CAPTURE_ALLOW_UNKNOWN_FLAG);
}

export const POINTER_CAPTURE_ALLOW_UNKNOWN_FLAG = "pointer-capture-allow-unknown";
export function pointerCaptureAllowUnknown(account: Parameters<typeof modelDetailsVisible>[0]): boolean {
  return actionsCaptureAvailable(account)
    && account?.kind === "signed_in" && !!account.organizationId
    && account.featureFlags?.source === "organization"
    && account.featureFlags.evaluatedFor.organizationId === account.organizationId
    && account.featureFlags.enabledSlugs.includes(POINTER_CAPTURE_ALLOW_UNKNOWN_FLAG);
}

/** Agent connection setup is independent of task execution and defaults off. */
export const AGENT_CONNECTIONS_FLAG = "enable-agent-connections";
export function agentConnectionsAvailable(account: Parameters<typeof modelDetailsVisible>[0]): boolean {
  return account?.kind === "signed_in"
    && account.featureFlags?.evaluatedFor.organizationId === (account.organizationId ?? null)
    && account.featureFlags?.enabledSlugs.includes(AGENT_CONNECTIONS_FLAG) === true;
}

/** Placement only: this never grants data access or enables analysis. */
export function actionsInSidebar(account: Parameters<typeof modelDetailsVisible>[0]): boolean {
  return account?.kind === "signed_in"
    && !!account.organizationId
    && account.featureFlags?.evaluatedFor.organizationId === account.organizationId
    && account.featureFlags?.enabledSlugs.includes("show-actions-page") === true;
}

/** Desktop Actions capture is opt-in and fails closed outside the active organization. */
export function actionsCaptureAvailable(account: Parameters<typeof modelDetailsVisible>[0]): boolean {
  return account?.kind === "signed_in"
    && !!account.organizationId
    && account.featureFlags?.evaluatedFor.organizationId === account.organizationId
    && account.featureFlags?.enabledSlugs.includes("enable-actions-capture") === true;
}
