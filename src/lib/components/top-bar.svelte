<script lang="ts">
  import { UserCard } from "@ambient/shared";
  import { cn } from "@ambient/shared/design";
  import type { BridgeStatus } from "../bridge-api";
  import { connectionLabel, hostFromOrigin } from "../format";
  import { statusDotClass } from "../status-dot";

  let {
    status,
    authBusy,
    onSignIn,
    onSignOut,
    onOpenSettings,
  }: {
    status: BridgeStatus;
    authBusy: boolean;
    onSignIn: () => void;
    onSignOut: () => void;
    onOpenSettings: () => void;
  } = $props();

  const enclaveHost = $derived(hostFromOrigin(status.inference.serverOrigin));
  const passedAttestationChecks = $derived(status.inference.attestationChecks.filter((check) => check.status === "passed").length);

  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
</script>

<header
  class="drag frost grid h-[46px] flex-none grid-cols-[minmax(48px,1fr)_minmax(0,auto)_minmax(48px,1fr)] items-center border-b border-line px-4 {isMac ? 'grid-cols-[minmax(76px,1fr)_minmax(0,auto)_minmax(76px,1fr)]' : ''}"
  data-testid="bridge-toolbar"
>
  <div
    class="no-drag col-start-2 flex h-8 min-w-0 max-w-full items-center gap-2.5 justify-self-center rounded-[var(--radius-md)] border border-line bg-surface/80 px-2.5"
    role="status"
    data-testid="bridge-toolbar-status"
    aria-label={`Bridge ${connectionLabel(status.connection)}. ${enclaveHost}. ${passedAttestationChecks} of ${status.inference.attestationChecks.length} attested.`}
  >
    <span class={cn("animate-heartbeat size-2 rounded-full", statusDotClass(status.connection))} aria-hidden="true"></span>
    <strong class="text-xs font-semibold capitalize text-ink">{connectionLabel(status.connection)}</strong>
    <span class="h-3.5 w-px shrink-0 bg-line max-[560px]:hidden" aria-hidden="true"></span>
    <span class="min-w-0 max-w-[150px] truncate font-mono text-xs text-ink-secondary max-[560px]:hidden" title={status.inference.serverOrigin}>{enclaveHost}</span>
    <span class="h-3.5 w-px shrink-0 bg-line" aria-hidden="true"></span>
    <span class="whitespace-nowrap text-xs text-ink-secondary"><strong class="tnum font-semibold text-ink">{passedAttestationChecks}/{status.inference.attestationChecks.length}</strong> attested</span>
  </div>

  <div class="no-drag col-start-3 flex items-center justify-self-end" data-testid="bridge-toolbar-account">
    <UserCard
      account={status.account}
      compact
      align="end"
      menuSize="compact"
      busy={authBusy}
      onSignIn={onSignIn}
      onRestartSignIn={onSignIn}
      onSignOut={onSignOut}
      onOpenSettings={onOpenSettings}
    />
  </div>
</header>
