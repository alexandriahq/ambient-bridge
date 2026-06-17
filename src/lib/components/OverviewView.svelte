<script lang="ts">
  import { Check, Trash2, X } from "@lucide/svelte";
  import type { BridgeStatus, BridgeUpdateStatus } from "../bridge-api";
  import {
    connectionLabel,
    formatClock,
    hostFromOrigin,
    ipcLabel,
    serverReachabilityLabel,
  } from "../format";

  let {
    status,
    updateStatus,
    pairingBusy,
    onCompletePairing,
    onRevokeClient,
  }: {
    status: BridgeStatus;
    updateStatus: BridgeUpdateStatus;
    pairingBusy: string | null;
    onCompletePairing: (requestId: string, approved: boolean) => void;
    onRevokeClient: (clientId: string) => void;
  } = $props();

  type AttestationDisplayState = "failed" | "not_checked" | "verified" | "verifying";

  function attestationDisplayState(): AttestationDisplayState {
    if (status.inference.attestation === "failed") return "failed";
    if (
      status.inference.attestation === "verified"
      || status.inference.attestationChecks.some((check) => check.status === "passed")
    ) {
      return "verified";
    }
    if (status.inference.attestationInProgress || status.inference.attestation === "verifying") {
      return "verifying";
    }
    return "not_checked";
  }

  function attestationLabel(): string {
    const state = attestationDisplayState();
    if (state === "verified") return "Verified";
    if (state === "failed") return "Check failed";
    if (state === "verifying") return "Verifying";
    return "Pending";
  }

  function attestationTone(): "verified" | "pending" | "failed" {
    const state = attestationDisplayState();
    if (state === "verified") return "verified";
    if (state === "failed") return "failed";
    return "pending";
  }

  function attestationChecksLabel(): string {
    const checks = status.inference.attestationChecks;
    if (checks.length === 0) {
      return status.inference.attestationInProgress ? "First check running" : "No checks yet";
    }
    const passed = checks.filter((check) => check.status === "passed").length;
    const refresh = status.inference.attestationInProgress && attestationDisplayState() === "verified"
      ? " · refreshing"
      : "";
    return `${passed}/${checks.length} passed${refresh}`;
  }

  function attestationLastPassLabel(): string {
    const lastPassed = status.inference.attestationChecks.find((check) => check.status === "passed");
    return lastPassed ? formatClock(lastPassed.checkedAt) : "None";
  }

  function clientPairedLabel(): string {
    if (status.pairedClients > 0) return "Yes";
    if (status.pairingRequests.length > 0) return "Pending";
    return "No";
  }

  function ipcDot(): string {
    return status.socketReady ? "ready" : "starting";
  }

  function serverDot(): string {
    if (status.serverReachability === "reachable") return "ready";
    if (status.serverReachability === "unavailable") return "offline";
    return "checking";
  }

  function pairedDot(): string {
    if (status.pairedClients > 0) return "ready";
    if (status.pairingRequests.length > 0) return "checking";
    return "offline";
  }

  function updateDetail(): string {
    if (updateStatus.updateError) return updateStatus.updateError;
    if (!updateStatus.enabled) return updateStatus.reason ?? "Automatic updates unavailable.";
    if (updateStatus.latestVersion && updateStatus.latestVersion !== updateStatus.currentVersion) {
      return `${updateStatus.currentVersion} → ${updateStatus.latestVersion}`;
    }
    return `${updateStatus.currentVersion} · ${updateStatus.channel}`;
  }
</script>

<section class="net-view overview-view" aria-label="Overview">
  <header class="net-intro">
    <dl class="overview-status">
      <div>
        <dt>Connection</dt>
        <dd>
          <span class="status-dot" data-state={status.connection} aria-hidden="true"></span>
          {connectionLabel(status.connection)}
        </dd>
      </div>
      <div>
        <dt>IPC socket</dt>
        <dd>
          <span class="status-dot" data-state={ipcDot()} aria-hidden="true"></span>
          {ipcLabel(status.socketReady)}
        </dd>
      </div>
      <div>
        <dt>Server</dt>
        <dd>
          <span class="status-dot" data-state={serverDot()} aria-hidden="true"></span>
          {serverReachabilityLabel(status.serverReachability)}
        </dd>
      </div>
      <div>
        <dt>Client paired</dt>
        <dd>
          <span class="status-dot" data-state={pairedDot()} aria-hidden="true"></span>
          {clientPairedLabel()}
        </dd>
      </div>
    </dl>
  </header>

  <section class="net-block" aria-labelledby="pairing-title">
    <h3 id="pairing-title" class="net-label">Ambient client</h3>

    {#if status.pairingRequests.length > 0}
      <ul class="pair-list" aria-label="Pending pairing requests">
        {#each status.pairingRequests as request (request.id)}
          <li class="pair-row">
            <div class="pair-id">
              <strong>{request.clientName}</strong>
              <span>Requested {formatClock(request.requestedAt)}</span>
            </div>
            <div class="row-actions">
              <button
                class="icon-button"
                type="button"
                title="Approve pairing"
                aria-label={`Approve ${request.clientName}`}
                disabled={pairingBusy === request.id}
                onclick={() => onCompletePairing(request.id, true)}
              >
                <Check size={15} aria-hidden="true" />
              </button>
              <button
                class="icon-button"
                type="button"
                title="Reject pairing"
                aria-label={`Reject ${request.clientName}`}
                disabled={pairingBusy === request.id}
                onclick={() => onCompletePairing(request.id, false)}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    {#if status.pairedClientList.length > 0}
      <ul class="pair-list" aria-label="Paired client">
        {#each status.pairedClientList as client (client.id)}
          <li class="pair-row" class:revoked={client.revokedAt !== null}>
            <div class="pair-id">
              <strong>{client.name}</strong>
              <span>
                {#if client.revokedAt !== null}
                  Revoked {formatClock(client.revokedAt)}
                {:else}
                  Paired {formatClock(client.pairedAt)}
                {/if}
              </span>
            </div>
            {#if client.revokedAt === null}
              <button
                class="icon-button"
                type="button"
                title="Revoke client"
                aria-label={`Revoke ${client.name}`}
                disabled={pairingBusy === client.id}
                onclick={() => onRevokeClient(client.id)}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {:else if status.pairingRequests.length === 0}
      <p class="empty-line">No Ambient client paired.</p>
    {/if}
  </section>

  <section class="overview-specs" aria-label="Bridge details">
    <div class="spec">
      <span class="net-label">Session</span>
      <dl class="kv">
        {#if status.account.kind === "signed_in"}
          <div><dt>Account</dt><dd>{status.account.email}</dd></div>
          {#if status.account.organizationName}
            <div><dt>Organization</dt><dd>{status.account.organizationName}</dd></div>
          {/if}
        {/if}
        <div><dt>Transport</dt><dd>OS IPC</dd></div>
        <div><dt>Logs</dt><dd>Sanitized</dd></div>
      </dl>
    </div>

    <div class="spec">
      <div class="spec-head">
        <span class="net-label">Attestation</span>
        <span class="attest" data-state={attestationTone()}>{attestationLabel()}</span>
      </div>
      <dl class="kv">
        <div><dt>Checks</dt><dd>{attestationChecksLabel()}</dd></div>
        <div><dt>Last pass</dt><dd>{attestationLastPassLabel()}</dd></div>
      </dl>
    </div>

    <div class="spec">
      <span class="net-label">Inference</span>
      <dl class="kv">
        <div><dt>Server</dt><dd>{hostFromOrigin(status.inference.serverOrigin)}</dd></div>
        <div><dt>Auth</dt><dd>WorkOS session</dd></div>
        <div><dt>Active</dt><dd>{status.inference.activeRequests}</dd></div>
        {#if status.inference.lastError}
          <div><dt>Error</dt><dd class="error-text">{status.inference.lastError}</dd></div>
        {/if}
      </dl>
    </div>

    <div class="spec">
      <span class="net-label">Updates</span>
      <dl class="kv">
        <div><dt>Version</dt><dd>{updateStatus.currentVersion}</dd></div>
        <div><dt>Channel</dt><dd>{updateStatus.channel}</dd></div>
        <div><dt>Status</dt><dd>{updateDetail()}</dd></div>
      </dl>
    </div>
  </section>
</section>
