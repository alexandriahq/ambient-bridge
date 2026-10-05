<script lang="ts">
  import SessionGuardCard from "@ambient/shared/components/session-guard-card";
  import { Button } from "@ambient/shared/ui/button";
  import { Card } from "@ambient/shared/ui/card";
  import { AmbientToaster } from "@ambient/shared/notifications";
  import { ModeWatcher } from "mode-watcher";
  import InfoIcon from "@lucide/svelte/icons/info";
  import Rows3Icon from "@lucide/svelte/icons/rows-3";
  import type {
    BridgeInferenceRequestStatus,
    BridgeRequestLogPatch,
    BridgeStatus,
    BridgeUpdateStatus,
  } from "../lib/bridge-api";
  import {
    BRIDGE_GUARD_ACTION_CHECK_STATUS,
    BRIDGE_GUARD_ACTION_RESTART_SIGN_IN,
    BRIDGE_GUARD_ACTION_RETRY_REACHABILITY,
    BRIDGE_GUARD_ACTION_SIGN_IN,
    composeBridgeSessionGuard,
  } from "../lib/session-guard";
  import BridgeAboutView from "../lib/components/bridge-about-view.svelte";
  import NetworkLogsView from "../lib/components/network-logs-view.svelte";
  import TopBar from "../lib/components/top-bar.svelte";
  import { startBridgeUpdateNotifications } from "../lib/update-notifications";
  import {
    BRIDGE_STATUS_SAFETY_POLL_MS,
    shouldRunBridgeStatusSafetyPoll,
    statusRefreshSetsLoading,
  } from "../lib/status-refresh-policy";
  import { applyRequestLogPatch, requestLogFromSnapshot } from "../lib/request-log";

  const fallbackStatus: BridgeStatus = {
    account: { kind: "signed_out" },
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
      responsePrivacy: "decrypts_in_bridge",
      serverAuth: "workos_session",
      serverOrigin: "unknown",
      wireCaptureRevision: 0,
    },
    plaintextInferenceWarningHidden: false,
    nodeRouting: {
      state: "unavailable",
      organizationId: null,
      workspaceId: null,
      workspaceKind: null,
      installationId: null,
      origin: null,
      capabilities: [],
      entitlements: { inference: false, multiplayer: false, publishing: false, mcp: false },
      inferenceMode: null,
      configurationVersion: null,
      message: null,
    },
    pairedClientList: [],
    pairedClients: 0,
    pairingRequests: [],
    runtimeIdentity: {
      channel: "development",
      commitSha: "unknown",
      serverUrl: "unknown",
      serverTarget: null,
      version: "0.0.0-dev",
    },
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
  let requests = $state<BridgeInferenceRequestStatus[]>([]);
  let requestLogRevision = $state(0);
  let updateStatus = $state<BridgeUpdateStatus>(fallbackUpdateStatus);
  let now = $state<number>(Date.now());
  let loading = $state(true);
  let statusLoaded = $state(false);
  let statusError = $state<string | null>(null);
  let authBusy = $state(false);
  let activePane = $state<"requests" | "about">("requests");
  let statusRefreshSequence = 0;

  function applyRequestLog(patch: BridgeRequestLogPatch): void {
    if (patch.revision < requestLogRevision && !patch.reset) return;
    requestLogRevision = patch.revision;
    requests = applyRequestLogPatch(requests, patch);
  }

  async function hydrateRequestLog(): Promise<void> {
    try {
      const snapshot = await window.ambientBridge?.getRequestLog();
      if (!snapshot) return;
      requestLogRevision = snapshot.revision;
      requests = requestLogFromSnapshot(snapshot);
    } catch {
      // Shell status remains usable; the log hydrates again on the next visible show.
    }
  }

  const sessionGuard = $derived(composeBridgeSessionGuard({ authBusy, loading, status }));

  async function refreshStatus(
    options: { readonly background?: boolean; readonly reachability?: boolean } = {},
  ) {
    const refreshSequence = ++statusRefreshSequence;
    const showLoading = statusRefreshSetsLoading(options);
    if (showLoading) loading = true;
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

  async function startLogin(options: { restart?: boolean; reopen?: boolean } = { reopen: true }) {
    authBusy = true;
    try {
      await window.ambientBridge?.startLogin(options);
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

  function openAbout(): void {
    activePane = "about";
    void refreshUpdateStatus();
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (sessionGuard.model) return;
    const key = event.key.toLowerCase();
    const isComma = key === "," || event.code === "Comma";
    const hasShortcutModifier = (event.metaKey && !event.ctrlKey) || (event.ctrlKey && !event.metaKey);
    if (!isComma || !hasShortcutModifier || event.altKey || event.shiftKey) return;
    event.preventDefault();
    openAbout();
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
    void hydrateRequestLog();
    const offStatusChanged = window.ambientBridge?.onStatusChanged(() => {
      void refreshStatus({ background: true });
    });
    const offRequestLogChanged = window.ambientBridge?.onRequestLogChanged((patch) => {
      applyRequestLog(patch);
    });
    const stopUpdateNotifications = startBridgeUpdateNotifications((nextStatus) => {
      updateStatus = nextStatus;
    });

    let safetyPoll: number | null = null;
    let nowTick: number | null = null;
    const clearSafetyPoll = () => {
      if (safetyPoll === null) return;
      window.clearInterval(safetyPoll);
      safetyPoll = null;
    };
    const clearNowTick = () => {
      if (nowTick === null) return;
      window.clearInterval(nowTick);
      nowTick = null;
    };
    const armVisibleTimers = () => {
      if (!shouldRunBridgeStatusSafetyPoll(document.visibilityState)) return;
      if (safetyPoll === null) {
        safetyPoll = window.setInterval(() => {
          void refreshStatus({ background: true });
          void refreshUpdateStatus();
        }, BRIDGE_STATUS_SAFETY_POLL_MS);
      }
      if (nowTick === null) {
        nowTick = window.setInterval(() => {
          now = Date.now();
        }, 5_000);
      }
    };
    const onVisibilityChange = () => {
      if (shouldRunBridgeStatusSafetyPoll(document.visibilityState)) {
        now = Date.now();
        void refreshStatus({ background: true });
        void refreshUpdateStatus();
        void hydrateRequestLog();
        armVisibleTimers();
        return;
      }
      clearSafetyPoll();
      clearNowTick();
    };

    armVisibleTimers();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearSafetyPoll();
      clearNowTick();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      offStatusChanged?.();
      offRequestLogChanged?.();
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
      <Button variant="secondary" size="sm" disabled={loading} onclick={() => void refreshStatus()} class="mt-5 no-drag">{loading ? "Trying…" : "Try again"}</Button>
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
    class="flex h-full w-full min-h-0 flex-col overflow-hidden bg-bg text-ink"
    data-testid="bridge-window-shell"
  >
      <TopBar
        {status}
        {authBusy}
        onSignIn={() => void startLogin()}
        onRestartSignIn={() => void startLogin({ restart: true })}
        onSignOut={signOut}
        onOpenAbout={openAbout}
      />

      {#if statusError}
        <div class="flex flex-none items-center justify-between gap-4 border-b border-warning/25 bg-warning/[0.05] px-4 py-2 text-xs text-warning" role="alert">
          <span>Showing the last known Bridge status. {statusError}</span>
          <Button variant="ghost" size="sm" disabled={loading} onclick={() => void refreshStatus()} class="no-drag">{loading ? "Retrying…" : "Retry"}</Button>
        </div>
      {/if}

      <div class="flex min-h-0 flex-1 overflow-hidden">
        <aside class="frost flex w-[188px] shrink-0 flex-col px-3 py-3">
          <nav aria-label="Bridge sections" class="space-y-0.5">
            <button
              type="button"
              onclick={() => activePane = "requests"}
              aria-current={activePane === "requests" ? "page" : undefined}
              class="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] px-3 text-sm font-medium transition-colors {activePane === 'requests' ? 'bg-ink/[0.07] text-ink' : 'text-ink-secondary hover:bg-ink/[0.04] hover:text-ink'}"
            >
              <Rows3Icon size={16} strokeWidth={1.75} aria-hidden="true" />
              Requests
            </button>

            <button
              type="button"
              onclick={openAbout}
              aria-current={activePane === "about" ? "page" : undefined}
              class="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] px-3 text-sm font-medium transition-colors {activePane === 'about' ? 'bg-ink/[0.07] text-ink' : 'text-ink-secondary hover:bg-ink/[0.04] hover:text-ink'}"
            >
              <InfoIcon size={16} strokeWidth={1.75} aria-hidden="true" />
              About
            </button>
          </nav>
        </aside>

        <div class="min-h-0 min-w-0 flex-1 pb-2 pr-2">
          <div class="inset-panel relative flex h-full flex-col overflow-hidden rounded-[14px] bg-surface" data-testid="bridge-inset-pane">
            {#if activePane === "requests"}
              <div class="mx-auto min-h-0 w-full max-w-[960px] flex-1 px-7 py-6">
                <NetworkLogsView {status} {requests} {now} />
              </div>
            {:else}
              <div class="scroll-area min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-8 py-8">
                <BridgeAboutView appVersion={status.appVersion} {updateStatus} />
              </div>
            {/if}
          </div>
        </div>
      </div>
  </main>
{/if}
