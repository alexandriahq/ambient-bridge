<script lang="ts">
  import { RefreshCw, UserCircle } from "@lucide/svelte";
  import type { BridgeStatus, BridgeUpdateStatus, BridgeView } from "../lib/bridge-api";
  import TopBar from "../lib/components/TopBar.svelte";
  import NetworkLogsView from "../lib/components/NetworkLogsView.svelte";
  import OverviewView from "../lib/components/OverviewView.svelte";

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
    },
    pairedClientList: [],
    pairedClients: 0,
    pairingRequests: [],
    serverReachable: false,
    serverReachability: "checking",
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
  let view = $state<BridgeView>("network");
  let now = $state<number>(Date.now());
  let loading = $state(false);
  let authBusy = $state(false);
  let switchingOrganizationId = $state<string | null>(null);
  let updateBusy = $state(false);
  let pairingBusy = $state<string | null>(null);

  async function refreshStatus() {
    loading = true;
    try {
      status = (await window.ambientBridge?.getStatus()) ?? fallbackStatus;
    } finally {
      loading = false;
    }
  }

  async function refreshUpdateStatus() {
    updateStatus = (await window.ambientBridge?.getUpdateStatus()) ?? fallbackUpdateStatus;
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

  async function switchOrganization(organizationId: string) {
    switchingOrganizationId = organizationId;
    try {
      await window.ambientBridge?.switchOrganization(organizationId);
      await refreshStatus();
    } finally {
      switchingOrganizationId = null;
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

  async function completePairing(requestId: string, approved: boolean) {
    pairingBusy = requestId;
    try {
      await window.ambientBridge?.completePairing(requestId, approved);
      await refreshStatus();
    } finally {
      pairingBusy = null;
    }
  }

  async function revokeClient(clientId: string) {
    pairingBusy = clientId;
    try {
      await window.ambientBridge?.revokeClient(clientId);
      await refreshStatus();
    } finally {
      pairingBusy = null;
    }
  }

  function loadWireCapture(requestId: string) {
    return window.ambientBridge?.getWireCapture(requestId) ?? Promise.resolve(null);
  }

  $effect(() => {
    void refreshStatus();
    void refreshUpdateStatus();
    const offStatusChanged = window.ambientBridge?.onStatusChanged(() => {
      void refreshStatus();
    });
    const offUpdateStatusChanged = window.ambientBridge?.onUpdateStatusChanged((nextStatus) => {
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
      offUpdateStatusChanged?.();
    };
  });
</script>

<svelte:head>
  <title>Ambient Bridge</title>
</svelte:head>

<div class="window-drag" aria-hidden="true"></div>

{#if status.account.kind !== "signed_in"}
  <main class="auth-shell">
    <section class="auth-gate" aria-labelledby="auth-title">
      <div class="brand auth-brand">
        <div class="brand-mark">A</div>
        <div>
          <h1>Ambient Bridge</h1>
          <p>{status.appVersion}</p>
        </div>
      </div>

      <div class="auth-copy">
        <p class="eyebrow">Account required</p>
        <h2 id="auth-title">
          {status.account.kind === "login_pending" ? "Complete sign-in in your browser" : "Sign in to continue"}
        </h2>
        {#if status.account.kind === "login_pending"}
          <p>Bridge is waiting for the server callback.</p>
        {:else}
          <p>Bridge stays locked until this device is signed in.</p>
        {/if}
        {#if status.authError}
          <p class="error-text auth-error">{status.authError}</p>
        {/if}
      </div>

      <div class="auth-actions">
        {#if status.account.kind === "login_pending"}
          <button class="text-button" onclick={refreshStatus} disabled={loading || authBusy}>
            <span class:spin={loading}>
              <RefreshCw size={17} />
            </span>
            Check status
          </button>
        {:else}
          <button class="primary-button" onclick={startLogin} disabled={authBusy}>
            <UserCircle size={17} />Sign in
          </button>
        {/if}
      </div>
    </section>
  </main>
{:else}
  <main class="bridge-shell">
    <TopBar
      {status}
      {updateStatus}
      {view}
      {authBusy}
      {switchingOrganizationId}
      {updateBusy}
      onSelectView={(next) => (view = next)}
      onSignOut={signOut}
      onSwitchOrganization={(organizationId) => void switchOrganization(organizationId)}
      onCheckForUpdates={checkForUpdates}
      onInstallUpdate={installUpdate}
    />

    <div class="view-scroll">
      {#if view === "network"}
        <NetworkLogsView {status} {now} loadWire={loadWireCapture} />
      {:else}
        <OverviewView
          {status}
          {updateStatus}
          {pairingBusy}
          onCompletePairing={completePairing}
          onRevokeClient={revokeClient}
        />
      {/if}
    </div>
  </main>
{/if}
