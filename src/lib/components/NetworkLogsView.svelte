<script lang="ts">
  import { ChevronRight, LockKeyhole, RefreshCw } from "@lucide/svelte";
  import type {
    BridgeActivityEvent,
    BridgeInferenceRequestStatus,
    BridgeStatus,
    BridgeWireCapture,
  } from "../bridge-api";
  import {
    eventCategory,
    formatBytes,
    formatClock,
    formatDuration,
    formatEventFields,
    formatRelative,
    hexDump,
    hostFromOrigin,
    humanizeEventName,
    routeLabel,
    truncate,
  } from "../format";

  let {
    status,
    now,
    loadWire,
  }: {
    status: BridgeStatus;
    now: number;
    loadWire: (requestId: string) => Promise<BridgeWireCapture | null>;
  } = $props();

  let expanded = $state<Record<string, boolean>>({});
  let activeCategory = $state<string>("all");
  let wireById = $state<Record<string, BridgeWireCapture | null>>({});
  let wireLoading = $state<Record<string, boolean>>({});

  const WIRE_DUMP_BYTES = 1024;

  const requests = $derived(status.inference.requests);
  const activity = $derived(status.activity);

  const categories = $derived([
    "all",
    ...Array.from(new Set(activity.map((event) => eventCategory(event.name)))).sort(),
  ]);

  const filteredActivity = $derived(
    activeCategory === "all"
      ? activity
      : activity.filter((event) => eventCategory(event.name) === activeCategory),
  );

  const verifiedRequests = $derived(
    requests.filter((request) => request.attestation === "verified").length,
  );

  function toggle(request: BridgeInferenceRequestStatus): void {
    const open = !expanded[request.requestId];
    expanded = { ...expanded, [request.requestId]: open };
    if (open && request.wireCaptured && wireById[request.requestId] === undefined) {
      void loadWireFor(request.requestId);
    }
  }

  async function loadWireFor(requestId: string): Promise<void> {
    wireLoading = { ...wireLoading, [requestId]: true };
    try {
      wireById = { ...wireById, [requestId]: await loadWire(requestId) };
    } finally {
      wireLoading = { ...wireLoading, [requestId]: false };
    }
  }

  function latencyMs(request: BridgeInferenceRequestStatus): number {
    return (request.completedAt ?? now) - request.startedAt;
  }

  function statusLabel(request: BridgeInferenceRequestStatus): string {
    if (request.status === "active") return "In flight";
    if (request.statusCode) return `${request.status} · ${request.statusCode}`;
    return request.status;
  }

  function attestationLabel(state: BridgeInferenceRequestStatus["attestation"]): string {
    if (state === "verified") return "Attested enclave";
    if (state === "failed") return "Attestation failed";
    return "Verifying enclave";
  }

  function traceEvents(requestId: string): BridgeActivityEvent[] {
    return activity.filter((event) => event.fields.requestId === requestId);
  }
</script>

<section class="net-view" aria-label="Network logs">
  <header class="net-intro">
    <h2 class="net-intro-title">
      <LockKeyhole size={16} aria-hidden="true" />
      Encrypted traffic
    </h2>
    <p>
      Every request is sealed on this device (EHBP / HPKE) and decrypts only inside the attested
      Tinfoil enclave — neither Bridge nor the Ambient server can read it.
    </p>
    <dl class="net-metrics">
      <div>
        <dd>{status.inference.activeRequests}</dd>
        <dt>In flight</dt>
      </div>
      <div>
        <dd>{requests.length}</dd>
        <dt>Requests</dt>
      </div>
      <div>
        <dd>{verifiedRequests}/{requests.length}</dd>
        <dt>Attested</dt>
      </div>
      <div>
        <dd title={status.inference.serverOrigin}>{hostFromOrigin(status.inference.serverOrigin)}</dd>
        <dt>Enclave via</dt>
      </div>
    </dl>
  </header>

  <section class="net-block" aria-labelledby="transfers-title">
    <h3 id="transfers-title" class="net-label">Outbound inference</h3>

    {#if requests.length === 0}
      <p class="empty-line">No data has left this device yet.</p>
    {:else}
      <ol class="request-log">
        {#each requests as request (request.requestId)}
          <li class="request-item" data-status={request.status}>
            <button
              type="button"
              class="request-row"
              aria-expanded={Boolean(expanded[request.requestId])}
              onclick={() => toggle(request)}
            >
              <span class="chevron" data-open={Boolean(expanded[request.requestId])} aria-hidden="true">
                <ChevronRight size={14} />
              </span>
              <span class="status-dot" data-state={request.status} aria-hidden="true"></span>
              <span class="route-badge">{routeLabel(request.path)}</span>
              <span class="request-model" title={request.model ?? undefined}>{request.model ?? "—"}</span>
              <span class="seal-chip" data-state={request.attestation} title={attestationLabel(request.attestation)}>
                <LockKeyhole size={11} aria-hidden="true" />EHBP
              </span>
              <span class="request-meta">
                <span class="request-status">{statusLabel(request)}</span>
                <span class="request-num">{formatDuration(latencyMs(request))}</span>
                <span class="request-num">{formatBytes(request.requestBytes)}</span>
                <time>{formatRelative(request.startedAt, now)}</time>
              </span>
            </button>

            {#if expanded[request.requestId]}
              <div class="request-detail">
                <div class="spec">
                  <div class="spec-head">
                    <span class="spec-label">Encryption envelope</span>
                    <span class="attest" data-state={request.attestation}>{attestationLabel(request.attestation)}</span>
                  </div>
                  <p class="sealed-line">
                    Body sealed with HPKE before egress — Bridge cannot read it.
                    <strong>{formatBytes(request.requestBytes)}</strong> sealed.
                  </p>
                  <dl class="kv">
                    <div><dt>Scheme</dt><dd>EHBP (HPKE) · decrypts only in enclave</dd></div>
                    <div><dt>Route</dt><dd>{request.path}</dd></div>
                    <div><dt>Request id</dt><dd class="mono">{request.requestId}</dd></div>
                    {#if request.ehbpResponseNonce}
                      <div><dt>Response nonce</dt><dd class="mono">{request.ehbpResponseNonce}</dd></div>
                    {/if}
                    {#if request.tinfoilRequestId}
                      <div><dt>Enclave req</dt><dd class="mono">{request.tinfoilRequestId}</dd></div>
                    {/if}
                    {#if request.usage}
                      <div>
                        <dt>Tokens</dt>
                        <dd>{request.usage.totalTokens} total · {request.usage.promptTokens} in / {request.usage.completionTokens} out</dd>
                      </div>
                    {/if}
                    <div><dt>Started</dt><dd>{formatClock(request.startedAt)}</dd></div>
                  </dl>
                  {#if request.error}
                    <p class="error-text">{truncate(request.error, 200)}</p>
                  {/if}
                </div>

                {#if traceEvents(request.requestId).length > 0}
                  <div class="spec">
                    <span class="spec-label">Trace</span>
                    <ol class="trace-list" aria-label="Request trace">
                      {#each traceEvents(request.requestId) as event}
                        <li>
                          <time>{formatClock(event.at)}</time>
                          <span>{humanizeEventName(event.name)}</span>
                        </li>
                      {/each}
                    </ol>
                  </div>
                {/if}

                {#if request.wireCaptured}
                  {@const wire = wireById[request.requestId]}
                  <div class="spec">
                    <div class="spec-head">
                      <span class="spec-label">On the wire</span>
                      <span class="spec-note">exact bytes sent to {hostFromOrigin(status.inference.serverOrigin)} · unreadable without the enclave key</span>
                      <button
                        type="button"
                        class="spec-refresh"
                        title="Refresh capture"
                        aria-label="Refresh wire capture"
                        disabled={Boolean(wireLoading[request.requestId])}
                        onclick={() => loadWireFor(request.requestId)}
                      >
                        <span class:spin={Boolean(wireLoading[request.requestId])}>
                          <RefreshCw size={12} aria-hidden="true" />
                        </span>
                      </button>
                    </div>

                    {#if wire === undefined || (wireLoading[request.requestId] && !wire)}
                      <p class="hint">Reading captured bytes…</p>
                    {:else if !wire}
                      <p class="hint">This capture is no longer retained (only the most recent requests keep raw bytes).</p>
                    {:else}
                      {@const reqDump = hexDump(wire.request.body.base64, WIRE_DUMP_BYTES)}
                      <div class="wire-part">
                        <p class="wire-line">
                          <span class="wire-verb">{wire.request.method}</span>{wire.request.url}
                        </p>
                        <dl class="kv">
                          {#each wire.request.headers as header}
                            <div>
                              <dt>{header.name}</dt>
                              <dd class="mono">{truncate(header.value, 96)}</dd>
                            </div>
                          {/each}
                        </dl>
                        <p class="wire-bytes-label">
                          Sealed request body ·
                          {formatBytes(wire.request.body.byteLength ?? wire.request.body.capturedBytes)}{wire.request.body.truncated ? "+" : ""}
                        </p>
                        {#if reqDump.text}
                          <pre class="hexdump">{reqDump.text}</pre>
                          {#if reqDump.total > reqDump.shown}
                            <p class="hint">Showing first {reqDump.shown} of {reqDump.total}{wire.request.body.truncated ? "+" : ""} captured bytes.</p>
                          {/if}
                        {:else}
                          <p class="hint">No request body.</p>
                        {/if}
                      </div>

                      {#if wire.response}
                        {@const respDump = hexDump(wire.response.body.base64, WIRE_DUMP_BYTES)}
                        <div class="wire-part">
                          <p class="wire-line">
                            <span class="wire-verb">←</span>HTTP {wire.response.status}
                          </p>
                          <dl class="kv">
                            {#each wire.response.headers as header}
                              <div>
                                <dt>{header.name}</dt>
                                <dd class="mono">{truncate(header.value, 96)}</dd>
                              </div>
                            {/each}
                          </dl>
                          <p class="wire-bytes-label">
                            Encrypted response body ·
                            {formatBytes(wire.response.body.byteLength ?? wire.response.body.capturedBytes)}{wire.response.body.truncated ? "+" : ""}
                          </p>
                          {#if respDump.text}
                            <pre class="hexdump">{respDump.text}</pre>
                            {#if respDump.total > respDump.shown}
                              <p class="hint">Showing first {respDump.shown} of {respDump.total}{wire.response.body.truncated ? "+" : ""} captured bytes.</p>
                            {/if}
                          {/if}
                        </div>
                      {:else}
                        <p class="hint">Encrypted response not captured yet — refresh after it completes.</p>
                      {/if}
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </section>

  <section class="net-block" aria-labelledby="stream-title">
    <div class="net-block-head">
      <h3 id="stream-title" class="net-label">Event stream</h3>
      <div class="filter-chips" role="group" aria-label="Filter events by category">
        {#each categories as category (category)}
          <button
            type="button"
            class="filter-chip"
            data-active={activeCategory === category}
            onclick={() => (activeCategory = category)}
          >
            {category}
          </button>
        {/each}
      </div>
    </div>

    {#if filteredActivity.length === 0}
      <p class="empty-line">No events recorded yet.</p>
    {:else}
      <ol class="event-stream">
        {#each filteredActivity as event}
          <li data-level={event.fields.level ?? "info"}>
            <time>{formatClock(event.at)}</time>
            <span class="event-cat">{eventCategory(event.name)}</span>
            <div class="event-body">
              <strong>{humanizeEventName(event.name)}</strong>
              {#if formatEventFields(event)}
                <p title={formatEventFields(event)}>{truncate(formatEventFields(event), 160)}</p>
              {/if}
            </div>
          </li>
        {/each}
      </ol>
    {/if}
  </section>
</section>
