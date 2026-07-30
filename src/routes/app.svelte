<script lang="ts">
  import { SessionGuardCard } from "@ambient/shared";
  import { Button, Card } from "@ambient/shared/design";
  import { AmbientToaster } from "@ambient/shared/notifications";
  import { ModeWatcher } from "mode-watcher";
  import type { BridgeExperimentalBuildsSnapshot, BridgeStatus, BridgeUpdateStatus } from "../lib/bridge-api";
  import {
    BRIDGE_GUARD_ACTION_CHECK_STATUS,
    BRIDGE_GUARD_ACTION_RESTART_SIGN_IN,
    BRIDGE_GUARD_ACTION_RETRY_REACHABILITY,
    BRIDGE_GUARD_ACTION_SIGN_IN,
    composeBridgeSessionGuard,
  } from "../lib/session-guard";
  import BridgeSettings from "../lib/components/bridge-settings.svelte";
  import NetworkLogsView from "../lib/components/network-logs-view.svelte";
  import TopBar from "../lib/components/top-bar.svelte";
  import { startBridgeUpdateNotifications } from "../lib/update-notifications";

  const fallbackStatus: BridgeStatus = {
    account: { kind: "signed_out" },
    activity: [],
    appVersion: "0.0.0-dev",
    connection: "starting",
    inference: {
      activeRequests: 0,
      attestation: "not_checked",
      attestationChecks: [],
      attestationInProgress: false,
      encryption: "ehbp",
      lastError: null,
      lastRequest: null,
      requests: [],
      responsePrivacy: "decrypts_in_bridge",
      serverAuth: "workos_session",
      serverOrigin: "unknown",
      wireCaptureRevision: 0,
    },
    pairedClientList: [],
    pairedClients: 0,
    pairingRequests: [],
    serverReachable: false,
    serverReachability: "checking",
    serverReachabilityCheckedAt: null,
    serverReachabilityHttpStatus: null,
    serverReachabilityMessage: "Server reachability has not been checked yet.",
    serverReachabilityReason: "not_checked",
    sessionRefresh: {
      attempt: 0,
      message: null,
      nextRetryAt: null,
      state: "ready",
    },
    socketReady: false,
  };

  const fallbackUpdateStatus: BridgeUpdateStatus = {
    channel: "alpha",
    checking: false,
    currentVersion: fallbackStatus.appVersion,
    downloaded: false,
    downloading: false,
    enabled: false,
    feedUrl: null,
    reason: "Updates are unavailable in this Bridge build.",
    updateAvailable: false,
  };

  let status = $state<BridgeStatus>(fallbackStatus);
  let updateStatus = $state<BridgeUpdateStatus>(fallbackUpdateStatus);
  let now = $state<number>(Date.now());
  let loading = $state(true);
  let statusLoaded = $state(false);
  let statusError = $state<string | null>(null);
  let authBusy = $state(false);
  let updateBusy = $state(false);
  let settingsOpen = $state(false);
  let statusRefreshSequence = 0;

  const sessionGuard = $derived(composeBridgeSessionGuard({ authBusy, loading, status }));
  const devtoolsEnabled = $derived(
    status.account.kind === "signed_in" && status.account.featureFlags.capabilities.devtooling,
  );

  async function refreshStatus(options: { readonly reachability?: boolean } = {}) {
    const refreshSequence = ++statusRefreshSequence;
    loading = true;
    try {
      const api = window.ambientBridge;
      if (!api) throw new Error("The Bridge runtime API is unavailable.");
      const nextStatus = options.reachability
        ? await api.retryReachability()
        : await api.getStatus();
      if (refreshSequence !== statusRefreshSequence) return;
      status = nextStatus;
      statusLoaded = true;
      statusError = null;
    } catch (cause) {
      if (refreshSequence !== statusRefreshSequence) return;
      statusError = cause instanceof Error ? cause.message : "Could not read Bridge status.";
    } finally {
      if (refreshSequence === statusRefreshSequence) loading = false;
    }
  }

  async function refreshUpdateStatus() {
    try {
      updateStatus = (await window.ambientBridge?.getUpdateStatus()) ?? fallbackUpdateStatus;
    } catch {
      // Update controls retain their last known state; the main status error is
      // surfaced separately and should not create an unhandled poll rejection.
    }
  }

  async function startLogin() {
    authBusy = true;
    try {
      await window.ambientBridge?.startLogin();
      await refreshStatus();
    } finally {
      authBusy = false;
    }
  }

  async function signOut() {
    authBusy = true;
    try {
      await window.ambientBridge?.signOut();
      await refreshStatus();
    } finally {
      authBusy = false;
    }
  }

  async function checkForUpdates() {
    updateBusy = true;
    try {
      updateStatus = (await window.ambientBridge?.checkForUpdates()) ?? updateStatus;
    } finally {
      updateBusy = false;
    }
  }

  async function installUpdate() {
    updateBusy = true;
    try {
      updateStatus = (await window.ambientBridge?.installUpdate()) ?? updateStatus;
    } finally {
      updateBusy = false;
    }
  }

  async function checkForStableUpdates() {
    const api = window.ambientBridge;
    const checkStable = api?.checkForStableUpdates ?? api?.checkForUpdates;
    if (!checkStable) throw new Error("Bridge main release update checks are unavailable in this window.");
    updateBusy = true;
    try {
      updateStatus = await checkStable();
    } finally {
      updateBusy = false;
    }
  }

  async function listExperimentalBuilds(): Promise<BridgeExperimentalBuildsSnapshot> {
    const api = window.ambientBridge;
    if (!api?.listExperimentalBuilds) {
      throw new Error("Experimental build listing is unavailable in this window.");
    }
    return api.listExperimentalBuilds();
  }

  async function installExperimentalBuild(releaseKey: string) {
    const api = window.ambientBridge;
    if (!api?.installExperimentalBuild) {
      throw new Error("Experimental build installation is unavailable in this window.");
    }
    updateBusy = true;
    try {
      updateStatus = await api.installExperimentalBuild(releaseKey);
    } finally {
      updateBusy = false;
    }
  }

  function openSettings(): void {
    settingsOpen = true;
    void refreshUpdateStatus();
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (sessionGuard.model) return;
    const key = event.key.toLowerCase();
    const isComma = key === "," || event.code === "Comma";
    const hasShortcutModifier = (event.metaKey && !event.ctrlKey) || (event.ctrlKey && !event.metaKey);
    if (!isComma || !hasShortcutModifier || event.altKey || event.shiftKey) return;
    event.preventDefault();
    openSettings();
  }

  function handleGuardAction(actionId: string): void {
    if (actionId === BRIDGE_GUARD_ACTION_SIGN_IN || actionId === BRIDGE_GUARD_ACTION_RESTART_SIGN_IN) {
      void startLogin();
      return;
    }
    if (actionId === BRIDGE_GUARD_ACTION_RETRY_REACHABILITY) {
      void refreshStatus({ reachability: true });
      return;
    }
    if (actionId === BRIDGE_GUARD_ACTION_CHECK_STATUS) {
      void refreshStatus();
    }
  }

  $effect(() => {
    void refreshStatus();
    void refreshUpdateStatus();
    const offStatusChanged = window.ambientBridge?.onStatusChanged(() => {
      void refreshStatus();
    });
    const stopUpdateNotifications = startBridgeUpdateNotifications((nextStatus) => {
      updateStatus = nextStatus;
    });
    const interval = window.setInterval(() => {
      now = Date.now();
      void refreshStatus();
      void refreshUpdateStatus();
    }, 3_000);
    return () => {
      window.clearInterval(interval);
      offStatusChanged?.();
      stopUpdateNotifications();
    };
  });

  $effect(() => {
    if (typeof window !== "undefined" && window.location.hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  });
</script>

<svelte:head>
  <title>Ambient Bridge</title>
</svelte:head>

<svelte:window onkeydown={handleWindowKeydown} />
<ModeWatcher />
<AmbientToaster />

{#if loading && !statusLoaded}
  <div class="drag pointer-events-none fixed inset-x-0 top-0 z-10 h-9" aria-hidden="true"></div>
  <main class="grid h-full w-full min-h-0 place-items-center overflow-y-auto bg-bg p-8 text-ink">
    <Card class="w-[min(100%,560px)] p-6" role="status">
      <h1 class="text-base font-semibold text-ink">Loading Bridge status…</h1>
      <p class="mt-2 text-sm text-ink-secondary">Reading the local account, connection, and request state.</p>
    </Card>
  </main>
{:else if statusError && !statusLoaded}
  <div class="drag pointer-events-none fixed inset-x-0 top-0 z-10 h-9" aria-hidden="true"></div>
  <main class="grid h-full w-full min-h-0 place-items-center overflow-y-auto bg-bg p-8 text-ink">
    <Card class="w-[min(100%,560px)] p-6" role="alert">
      <h1 class="text-base font-semibold text-ink">Bridge status unavailable</h1>
      <p class="mt-2 text-sm text-ink-secondary">{statusError}</p>
      <Button class="mt-5" size="sm" disabled={loading} onclick={() => void refreshStatus()}>{loading ? "Trying…" : "Try again"}</Button>
    </Card>
  </main>
{:else if sessionGuard.model}
  <div class="drag pointer-events-none fixed inset-x-0 top-0 z-10 h-9" aria-hidden="true"></div>
  <main
    class="grid h-full w-full min-h-0 place-items-center content-center gap-8 overflow-y-auto overflow-x-hidden bg-bg p-8 text-ink"
  >
    <div class="flex w-[min(100%,560px)] min-w-0 items-center gap-3">
      <div
        class="grid size-9 flex-none place-items-center rounded-[var(--radius-md)] border border-line bg-primary text-sm font-bold leading-none text-on-primary"
      >
        A
      </div>
      <div>
        <h1 class="text-base font-semibold text-ink">Ambient Bridge</h1>
        <p class="text-sm text-ink-secondary">{status.appVersion}</p>
      </div>
    </div>
    <SessionGuardCard model={sessionGuard.model} onAction={handleGuardAction} />
  </main>
{:else}
  <main
    class="flex h-full w-full min-h-0 flex-col overflow-hidden bg-surface text-ink"
    data-testid="bridge-window-shell"
  >
      <TopBar
        {status}
        {authBusy}
        onSignIn={startLogin}
        onSignOut={signOut}
        onOpenSettings={openSettings}
      />

      {#if statusError}
        <div class="flex flex-none items-center justify-between gap-4 border-b border-warning/25 bg-warning/[0.05] px-4 py-2 text-xs text-warning" role="alert">
          <span>Showing the last known Bridge status. {statusError}</span>
          <Button variant="ghost" size="sm" disabled={loading} onclick={() => void refreshStatus()}>{loading ? "Retrying…" : "Retry"}</Button>
        </div>
      {/if}

      <div class="min-h-0 flex-1 overflow-hidden">
        <div class="mx-auto h-full max-w-[860px] px-7 py-6">
          <NetworkLogsView {status} {now} />
        </div>
      </div>
  </main>
{/if}

<BridgeSettings
  bind:open={settingsOpen}
  appVersion={status.appVersion}
  {devtoolsEnabled}
  {updateStatus}
  {updateBusy}
  onCheckForUpdates={checkForUpdates}
  onCheckForStableUpdates={checkForStableUpdates}
  onInstallUpdate={installUpdate}
  onListExperimentalBuilds={listExperimentalBuilds}
  onInstallExperimentalBuild={installExperimentalBuild}
/>
