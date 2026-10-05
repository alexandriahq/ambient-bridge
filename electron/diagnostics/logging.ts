/**
 * Bridge's closed logging taxonomy, mirroring the Ambient app's
 * (ambient-app/observability/logging.ts): every structured record that reaches
 * the crash ring and local audit log carry a `service` and `component` from
 * these sets, so queries work the same way across both products.
 */

export const BRIDGE_LOG_SERVICES = {
  electronMain: "bridge/electron-main",
  diagnostics: "bridge/diagnostics",
} as const;

export type BridgeLogService = typeof BRIDGE_LOG_SERVICES[keyof typeof BRIDGE_LOG_SERVICES];

export const BRIDGE_LOG_COMPONENTS = {
  bridgeMain: "bridge-main",
  analytics: "bridge-analytics",
  auth: "bridge-auth",
  diagnostics: "bridge-diagnostics",
  inference: "bridge-inference",
  ipc: "bridge-ipc",
  pairing: "bridge-pairing",
  server: "bridge-server",
  updates: "bridge-updates",
} as const;

export type BridgeLogComponent = typeof BRIDGE_LOG_COMPONENTS[keyof typeof BRIDGE_LOG_COMPONENTS];

const AUDIT_EVENT_COMPONENT_PREFIXES: ReadonlyArray<readonly [string, BridgeLogComponent]> = [
  ["analytics.", BRIDGE_LOG_COMPONENTS.analytics],
  ["auth.", BRIDGE_LOG_COMPONENTS.auth],
  ["crash.", BRIDGE_LOG_COMPONENTS.diagnostics],
  ["inference.", BRIDGE_LOG_COMPONENTS.inference],
  ["ipc.", BRIDGE_LOG_COMPONENTS.ipc],
  ["pairing.", BRIDGE_LOG_COMPONENTS.pairing],
  ["process.", BRIDGE_LOG_COMPONENTS.bridgeMain],
  ["server.", BRIDGE_LOG_COMPONENTS.server],
  ["update.", BRIDGE_LOG_COMPONENTS.updates],
  ["updates.", BRIDGE_LOG_COMPONENTS.updates],
];

/** Map an audit event name (e.g. "auth.login_start") onto the component taxonomy. */
export function bridgeComponentForAuditEvent(name: string): BridgeLogComponent {
  for (const [prefix, component] of AUDIT_EVENT_COMPONENT_PREFIXES) {
    if (name.startsWith(prefix)) return component;
  }
  return BRIDGE_LOG_COMPONENTS.bridgeMain;
}

export function bridgeServiceForComponent(component: BridgeLogComponent): BridgeLogService {
  return component === BRIDGE_LOG_COMPONENTS.diagnostics
    ? BRIDGE_LOG_SERVICES.diagnostics
    : BRIDGE_LOG_SERVICES.electronMain;
}
