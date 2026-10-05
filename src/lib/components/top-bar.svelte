<script lang="ts">
  import TrafficLights from "@ambient/shared/components/traffic-lights";
  import UserCard from "@ambient/shared/components/user-card";
  import WindowControls from "@ambient/shared/components/window-controls";
  import { cn } from "@ambient/shared/utils";
  import type { BridgeStatus } from "../bridge-api";
  import { connectionLabel, hostFromOrigin } from "../format";
  import { statusDotClass } from "../status-dot";

  let {
    status,
    authBusy,
    onSignIn,
    onRestartSignIn,
    onSignOut,
    onOpenAbout,
  }: {
    status: BridgeStatus;
    authBusy: boolean;
    onSignIn: () => void;
    onRestartSignIn?: () => void;
    onSignOut: () => void;
    onOpenAbout: () => void;
  } = $props();

  const enclaveHost = $derived(hostFromOrigin(status.inference.serverOrigin));
  const passedAttestationChecks = $derived(status.inference.attestationChecks.filter((check) => check.status === "passed").length);
  // Continuous heartbeat dirties DWM every ~1.9s and pairs badly with Ambient's
  // 2s DXGI screen capture; animate only while connection is still settling.
  const pulseStatusDot = $derived(
    status.connection === "starting"
      || status.connection === "checking"
      || status.connection === "retrying"
      || status.connection === "degraded"
      || status.connection === "proxy_unavailable",
  );

  // Prefer mock/Electron `data-platform` so win32 caption reserve + UserCard
  // placement match Ambient app; fall back to UA only when unset.
  const platform =
    typeof document !== "undefined"
      ? document.documentElement.getAttribute("data-platform")
      : null;
  const isMac = platform === "darwin"
    || (platform == null && typeof navigator !== "undefined" && /mac/i.test(navigator.platform));
  // Real Electron win32 needs caption headroom; mock paints in-flow WindowControls.
  const isElectronWin = platform === "win32"
    && typeof document !== "undefined"
    && document.documentElement.getAttribute("data-ambient-mock") !== "true";
  // Absolute-centered status must stay clear of left traffic lights and the
  // right account / window-control cluster (wider on win32/linux mock).
  const statusMaxWidth = isMac
    ? "calc(100% - 11rem)"
    : "calc(100% - 14rem)";
</script>

<header
  class="drag relative flex h-[46px] flex-none items-center justify-between px-4 {isElectronWin ? 'pr-[138px]' : ''}"
  data-testid="bridge-toolbar"
>
  <div class="no-drag relative z-10 flex min-w-0 items-center" aria-hidden="true">
    <TrafficLights />
  </div>
  <div
    class="no-drag pointer-events-none absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center justify-center px-2"
    style={`max-width: ${statusMaxWidth};`}
  >
    <div
      class="pointer-events-auto flex h-8 min-w-0 max-w-full items-center gap-2.5 overflow-hidden rounded-[var(--radius-md)] border border-line bg-surface/80 px-2.5"
      role="status"
      data-testid="bridge-toolbar-status"
      aria-label={`Bridge ${connectionLabel(status.connection)}. ${enclaveHost}. ${passedAttestationChecks} of ${status.inference.attestationChecks.length} attested.`}
    >
      <span class={cn("size-2 shrink-0 rounded-full", pulseStatusDot && "animate-heartbeat", statusDotClass(status.connection))} aria-hidden="true"></span>
      <strong class="truncate text-xs font-semibold capitalize text-ink">{connectionLabel(status.connection)}</strong>
      <span class="h-3.5 w-px shrink-0 bg-line max-[560px]:hidden" aria-hidden="true"></span>
      <span class="min-w-0 max-w-[150px] truncate font-mono text-xs text-ink-secondary max-[560px]:hidden" title={status.inference.serverOrigin}>{enclaveHost}</span>
      <span class="h-3.5 w-px shrink-0 bg-line max-[480px]:hidden" aria-hidden="true"></span>
      <span class="truncate text-xs text-ink-secondary max-[480px]:hidden"><strong class="tnum font-semibold text-ink">{passedAttestationChecks}/{status.inference.attestationChecks.length}</strong> attested</span>
    </div>
  </div>

  <div class="no-drag relative z-10 flex h-full min-w-0 items-center gap-2" data-testid="bridge-toolbar-account">
    <UserCard
      account={status.account}
      compact
      align="end"
      menuSize="compact"
      busy={authBusy}
      onSignIn={onSignIn}
      onRestartSignIn={onRestartSignIn ?? onSignIn}
      onSignOut={onSignOut}
      onOpenSettings={onOpenAbout}
      settingsLabel="About"
    />
    <WindowControls />
  </div>
</header>
