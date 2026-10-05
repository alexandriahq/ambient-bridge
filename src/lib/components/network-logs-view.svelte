<script lang="ts">
  import { modelDetailsVisible } from "@ambient/shared/feature-flags";
	import CheckIcon from "@lucide/svelte/icons/check";
	import ClipboardIcon from "@lucide/svelte/icons/clipboard";
	import LockIcon from "@lucide/svelte/icons/lock";
  import { Button } from "@ambient/shared/ui/button";
  import { Card } from "@ambient/shared/ui/card";
  import * as Dialog from "@ambient/shared/ui/dialog";
  import { Badge } from "@ambient/shared/ui/badge";
  import { cn } from "@ambient/shared/utils";
  import type {
    BridgeInferenceRequestStatus,
    BridgeStatus,
    BridgeWireCapture,
  } from "../bridge-api";
  import { formatBytes, formatDuration, formatRelative, routeLabel } from "../format";
  import { statusDotClass } from "../status-dot";

  let {
    status,
    requests,
    now,
  }: {
    status: BridgeStatus;
    requests: readonly BridgeInferenceRequestStatus[];
    now: number;
  } = $props();

  const showModelDetails = $derived(modelDetailsVisible(status.account));
  const visibleError = (error: string) => showModelDetails ? error : "The inference request failed. Retry or contact support.";

  let detailsOpen = $state(false);
  let selectedRequestId = $state<string | null>(null);
  let selectedRequestSnapshot = $state<BridgeInferenceRequestStatus | null>(null);
  const selectedRequestLive = $derived(
    requests.find((request) => request.requestId === selectedRequestId) ?? null,
  );
  const selectedRequest = $derived(
    selectedRequestLive ?? selectedRequestSnapshot,
  );
  let wireCapture = $state<BridgeWireCapture | null>(null);
  let wireCaptureState = $state<"idle" | "available" | "evicted" | "not_captured" | "pending">("idle");
  let wireCaptureLoading = $state(false);
  let wireCaptureError = $state<string | null>(null);
  let wireCaptureLookupKey = $state<string | null>(null);
  let cipherIdentity = $state<{ fingerprint: string; randomart: string } | null>(null);
  let rawCopyState = $state<"idle" | "copied" | "failed">("idle");
  let detailsScrolling = $state(false);
  let detailsScrollTimeout: ReturnType<typeof setTimeout> | null = null;
  let detailsThumbHeight = $state(32);
  let detailsThumbTop = $state(0);
  let detailsCanScroll = $state(false);
  let wireCaptureLoadSequence = 0;

  $effect(() => () => {
    if (detailsScrollTimeout) clearTimeout(detailsScrollTimeout);
  });

  $effect(() => {
    if (!detailsOpen || !selectedRequest) return;
    const lookupKey = `${selectedRequest.requestId}:${selectedRequest.status}:${selectedRequest.wireCaptured}:${status.inference.wireCaptureRevision}`;
    if (wireCaptureLookupKey === lookupKey) return;
    void loadWireCapture(selectedRequest.requestId, lookupKey);
  });

  $effect(() => {
    if (!detailsOpen || !selectedRequestId || selectedRequestLive) return;
    closeInspector();
  });

  $effect(() => {
    if (detailsOpen) return;
    releaseInspector();
  });

  function latency(request: BridgeInferenceRequestStatus): number {
    return (request.completedAt ?? now) - request.startedAt;
  }

  function phaseDuration(timestamp: number | null, startedAt: number): string {
    return timestamp === null ? "—" : formatDuration(timestamp - startedAt);
  }

  function requestStatus(request: BridgeInferenceRequestStatus): string {
    if (request.status === "active") return "In flight";
    return request.statusCode ? `${request.status} · ${request.statusCode}` : request.status;
  }

  function statusTone(request: BridgeInferenceRequestStatus): string {
    if (request.status === "failed" || request.status === "cancelled") return "text-danger";
    if (request.status === "active") return "text-success";
    return "text-ink-secondary";
  }

  function attestationLabel(attestation: BridgeInferenceRequestStatus["attestation"]): string {
    if (attestation === "verified") return "Attested";
    if (attestation === "skipped") return "Not attested";
    return attestation;
  }

  function attestationTone(attestation: BridgeInferenceRequestStatus["attestation"]): string {
    if (attestation === "verified") return "text-success";
    if (attestation === "failed") return "text-danger";
    if (attestation === "skipped") return "text-ink-secondary";
    return "text-warning";
  }

  function formatTimestamp(value: number | null): string {
    if (value === null) return "—";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(value);
  }

  function base64Bytes(value: string) {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function randomart(bytes: Uint8Array): string {
    const width = 17;
    const height = 9;
    const board = Array.from({ length: height }, () => Array<number>(width).fill(0));
    const symbols = " .o+=*BOX@%&#/^";
    const startX = Math.floor(width / 2);
    const startY = Math.floor(height / 2);
    let x = startX;
    let y = startY;

    for (const byte of bytes) {
      for (let shift = 0; shift < 8; shift += 2) {
        const direction = (byte >> shift) & 3;
        x = Math.max(0, Math.min(width - 1, x + (direction & 1 ? 1 : -1)));
        y = Math.max(0, Math.min(height - 1, y + (direction & 2 ? 1 : -1)));
        board[y][x] += 1;
      }
    }

    const rows = board.map((row) => row.map((visits) => symbols[Math.min(visits, symbols.length - 1)]).join(""));
    rows[startY] = `${rows[startY].slice(0, startX)}S${rows[startY].slice(startX + 1)}`;
    rows[y] = `${rows[y].slice(0, x)}E${rows[y].slice(x + 1)}`;
    return rows.join("\n");
  }

  async function analyzeCiphertext(base64: string): Promise<{ fingerprint: string; randomart: string }> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", base64Bytes(base64)));
    const digestBinary = Array.from(digest, (byte) => String.fromCharCode(byte)).join("");
    return {
      fingerprint: `SHA256:${btoa(digestBinary).replace(/=+$/, "")}`,
      randomart: randomart(digest),
    };
  }

  function wireHeader(name: string): string {
    return wireCapture?.request.headers.find((header) => header.name === name)?.value ?? "—";
  }

  function handleDetailsScroll(event: Event): void {
    const scroller = event.currentTarget as HTMLElement;
    const scrollRange = scroller.scrollHeight - scroller.clientHeight;
    detailsCanScroll = scrollRange > 0;
    detailsThumbHeight = Math.max(32, (scroller.clientHeight / scroller.scrollHeight) * scroller.clientHeight);
    const thumbRange = scroller.clientHeight - detailsThumbHeight;
    detailsThumbTop = scrollRange > 0 ? (scroller.scrollTop / scrollRange) * thumbRange : 0;
    detailsScrolling = true;
    if (detailsScrollTimeout) clearTimeout(detailsScrollTimeout);
    detailsScrollTimeout = setTimeout(() => {
      detailsScrolling = false;
      detailsScrollTimeout = null;
    }, 700);
  }

  async function copyRawPayload(): Promise<void> {
    if (!wireCapture || !selectedRequest) return;
    const requestId = selectedRequest.requestId;
    try {
      const result = await window.ambientBridge?.copyWirePayload(requestId);
      if (!detailsOpen || selectedRequestId !== requestId) return;
      if (!result || result.status !== "copied") {
        if (result?.status === "evicted" || result?.status === "not_captured" || result?.status === "pending") {
          wireCaptureState = result.status;
          wireCapture = null;
          cipherIdentity = null;
        }
        throw new Error("Clipboard unavailable");
      }
      rawCopyState = "copied";
    } catch {
      if (!detailsOpen || selectedRequestId !== requestId) return;
      rawCopyState = "failed";
    }
  }

  function retryWireCapture(): void {
    wireCaptureError = null;
    wireCaptureLookupKey = null;
  }

  async function loadWireCapture(requestId: string, lookupKey: string): Promise<void> {
    const loadSequence = ++wireCaptureLoadSequence;
    const preserveCurrentCapture = wireCapture?.requestId === requestId;
    wireCaptureLookupKey = lookupKey;
    if (!preserveCurrentCapture) {
      wireCapture = null;
      cipherIdentity = null;
    }
    rawCopyState = "idle";
    wireCaptureError = null;
    wireCaptureLoading = !preserveCurrentCapture;
    try {
      const result = await window.ambientBridge?.getWireCapture(requestId);
      if (loadSequence !== wireCaptureLoadSequence || !detailsOpen || selectedRequestId !== requestId) return;
      wireCaptureState = result?.state ?? "not_captured";
      if (result?.state === "available") {
        const nextIdentity = await analyzeCiphertext(result.capture.request.body.base64);
        if (loadSequence !== wireCaptureLoadSequence || !detailsOpen || selectedRequestId !== requestId) return;
        wireCapture = result.capture;
        cipherIdentity = nextIdentity;
      } else {
        wireCapture = null;
        cipherIdentity = null;
      }
    } catch (cause) {
      if (loadSequence !== wireCaptureLoadSequence || !detailsOpen || selectedRequestId !== requestId) return;
      wireCapture = null;
      cipherIdentity = null;
      wireCaptureError = cause instanceof Error ? cause.message : "Could not load the captured payload.";
    } finally {
      if (loadSequence === wireCaptureLoadSequence) wireCaptureLoading = false;
    }
  }

  function inspectRequest(request: BridgeInferenceRequestStatus): void {
    releaseInspector();
    selectedRequestId = request.requestId;
    selectedRequestSnapshot = request;
    detailsOpen = true;
  }

  function closeInspector(): void {
    detailsOpen = false;
    releaseInspector();
  }

  function releaseInspector(): void {
    wireCaptureLoadSequence += 1;
    selectedRequestId = null;
    selectedRequestSnapshot = null;
    wireCaptureLookupKey = null;
    wireCaptureState = "idle";
    wireCapture = null;
    cipherIdentity = null;
    rawCopyState = "idle";
    wireCaptureError = null;
    wireCaptureLoading = false;
  }
</script>

<section class="flex h-full min-h-0 flex-col gap-4" aria-label="Requests">
  <header class="flex flex-none items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight text-ink">Requests</h1>
      <p class="mt-1 text-sm text-ink-tertiary">Inference requests and transport status through this Bridge.</p>
    </div>
    <Badge variant="secondary" class="text-success"><LockIcon size={12} /> EHBP / HPKE</Badge>
  </header>

  <section class="flex min-h-0 flex-1 flex-col gap-2" aria-labelledby="request-list-title">
    <div class="flex flex-none items-center justify-between px-1">
      <h2 id="request-list-title" class="text-sm font-semibold text-ink">All requests</h2>
      <span class="tnum text-xs text-ink-faint">{requests.length} total</span>
    </div>

    <Card class="min-h-0 flex-1 overflow-hidden p-0">
      {#if requests.length === 0}
        <div class="grid h-full place-items-center px-5 text-center">
          <div>
            <LockIcon size={20} class="mx-auto text-ink-faint" />
            <p class="mt-2 text-sm font-medium text-ink">No inference traffic yet</p>
            <p class="mt-1 text-xs text-ink-tertiary">Requests will appear here as they pass through the Bridge.</p>
          </div>
        </div>
      {:else}
        <ol class="h-full overflow-y-auto overscroll-contain divide-y divide-line" data-testid="request-list">
          {#each requests as request (request.requestId)}
            <li>
              <button
                type="button"
                class="group grid min-h-16 w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink/[0.035] focus-visible:bg-ink/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
                aria-label={`Inspect ${routeLabel(request.path)} request ${request.requestId}`}
                onclick={() => inspectRequest(request)}
              >
                <span class={cn("size-2 rounded-full ring-[3px]", statusDotClass(request.status))} aria-hidden="true"></span>
                <div class="min-w-0">
                  <div class="flex min-w-0 items-baseline gap-2">
                    <strong class="flex-none text-sm font-medium text-ink">{routeLabel(request.path)}</strong>
                    {#if showModelDetails}<span class="truncate font-mono text-xs text-ink-tertiary">{request.model ?? "—"}</span>{/if}
                  </div>
                  {#if request.error}
                    <p class="mt-1 line-clamp-2 text-xs text-danger">{visibleError(request.error)}</p>
                  {/if}
                  <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
                    <span class="font-mono">{request.requestId}</span>
                    <span class="tnum">{formatDuration(latency(request))}</span>
                    <span class="tnum">{formatBytes(request.requestBytes)}</span>
                    <span>{formatRelative(request.startedAt, now)}</span>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <Badge variant="secondary" size="sm" class={attestationTone(request.attestation)}>
                    <LockIcon size={11} /> {attestationLabel(request.attestation)}
                  </Badge>
                  <Badge variant="secondary" size="sm" class={statusTone(request)}>
                    <span class="size-1.5 rounded-full bg-current opacity-70" aria-hidden="true"></span>
                    {requestStatus(request)}
                  </Badge>
                  <span class="text-xs text-ink-faint transition-transform group-hover:translate-x-0.5" aria-hidden="true">›</span>
                </div>
              </button>
            </li>
          {/each}
        </ol>
      {/if}
    </Card>
  </section>
</section>

<Dialog.Root bind:open={detailsOpen}>
  <Dialog.Content
    class="card elevate-lg flex h-[calc(100dvh-3rem)] max-w-[760px] flex-col gap-0 overflow-hidden bg-surface p-0"
    style="animation: floatIn 0.28s var(--ease-out-quint) both"
  >
    <Dialog.Header class="flex-row items-center gap-3 border-b border-line px-4 py-3 pr-12">
      <Dialog.Title class="flex-1 text-md font-semibold text-ink">
        {selectedRequest ? `${routeLabel(selectedRequest.path)} request` : "Request details"}
      </Dialog.Title>
    </Dialog.Header>
    <div class="min-h-0 flex-1 overflow-hidden p-0">
      {#if selectedRequest}
        <div class="relative h-full min-h-0">
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (The overflow region must be keyboard-scrollable.) -->
      <div
        class="request-detail-scroll h-full overflow-y-auto overscroll-contain"
        class:is-scrolling={detailsScrolling}
        data-testid="request-details"
        role="region"
        aria-label="Request details"
        tabindex="0"
        onscroll={handleDetailsScroll}
      >
      {#if selectedRequest.error}
        <div class="border-b border-danger/30 bg-danger/[0.04] px-4 py-3 text-sm text-danger" role="alert" data-testid="request-error">
          <p>{visibleError(selectedRequest.error)}</p>
          <p class="mt-2 text-xs">Failed at {selectedRequest.completedAt === null ? "Unknown" : new Date(selectedRequest.completedAt).toISOString()} · Request {selectedRequest.requestId}</p>
        </div>
      {/if}
      <section class="sticky top-0 z-10 border-b border-line bg-surface px-4 py-3" aria-label="Ciphertext identity" data-testid="cipher-summary">
        {#if wireCaptureLoading}
          <div class="grid h-[220px] place-items-center rounded-[var(--radius-lg)] border border-line bg-surface-2/50 text-sm text-ink-secondary" role="status">Building ciphertext identity…</div>
        {:else if wireCaptureError}
          <div class="flex items-center justify-between gap-4 rounded-[var(--radius-md)] border border-danger/30 bg-danger/[0.04] px-4 py-3 text-sm text-danger" role="alert">
            <span>{wireCaptureError}</span>
            <Button variant="ghost" size="sm" onclick={retryWireCapture} class="no-drag">Retry</Button>
          </div>
        {:else if wireCaptureState === "pending"}
          <div class="rounded-[var(--radius-md)] border border-line bg-surface-2/40 px-4 py-5 text-sm text-ink-secondary" role="status">The sealed request is still being captured. This inspector will refresh automatically.</div>
        {:else if wireCaptureState === "evicted"}
          <div class="rounded-[var(--radius-md)] border border-line px-4 py-5 text-sm text-ink-secondary">This ciphertext was captured, but its bounded in-memory copy has since expired.</div>
        {:else if wireCaptureState === "not_captured" || !wireCapture}
          <div class="rounded-[var(--radius-md)] border border-line px-4 py-5 text-sm text-ink-secondary">No sealed wire payload is available for this request.</div>
        {:else if cipherIdentity}
          <div class="grid overflow-hidden rounded-[var(--radius-lg)] border border-line min-[600px]:grid-cols-[220px_minmax(0,1fr)]">
            <div class="relative grid content-between overflow-hidden bg-primary p-3 text-on-primary">
              <div class="pointer-events-none absolute -right-10 -top-10 size-32 rounded-full border border-on-primary/10"></div>
              <div class="relative flex items-center justify-between gap-3">
                <span class="text-2xs font-semibold uppercase tracking-[0.18em] text-on-primary/60">{wireCapture.request.body.truncated ? "Prefix cipherprint" : "Cipherprint"}</span>
                <LockIcon size={14} class="text-on-primary/60" />
              </div>
              <pre
                class="relative m-0 justify-self-center font-mono text-2xs leading-[1.12] tracking-[0.12em] text-on-primary"
                role="img"
                aria-label={wireCapture.request.body.truncated
                  ? "SSH-style randomart generated from the captured ciphertext prefix fingerprint"
                  : "SSH-style randomart generated from the captured ciphertext fingerprint"}
              >{cipherIdentity.randomart}</pre>
              <div class="relative flex items-center justify-between gap-2 text-2xs text-on-primary/60">
                <span>[SHA256]</span>
                <span>EHBP · HPKE</span>
              </div>
            </div>

            <div class="grid content-between gap-3 bg-surface p-3">
              <div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-2xs font-semibold uppercase tracking-wider text-ink-faint">{wireCapture.request.body.truncated ? "Sealed request · captured prefix" : "Sealed request"}</span>
                  <div class="flex items-center gap-1.5">
                    {#if wireCapture.request.body.truncated}
                      <Badge variant="secondary" size="sm" class="text-warning">Truncated</Badge>
                    {/if}
                    <Badge variant="secondary" size="sm" class={attestationTone(selectedRequest.attestation)}>
                      <span class="size-1.5 rounded-full bg-current opacity-70" aria-hidden="true"></span>
                      {attestationLabel(selectedRequest.attestation)}
                    </Badge>
                  </div>
                </div>
                <p class="mt-2 truncate whitespace-nowrap font-mono text-2xs tracking-tight text-ink" title={cipherIdentity.fingerprint} data-testid="cipher-fingerprint">{cipherIdentity.fingerprint}</p>
              </div>

              <dl class="grid grid-cols-2 gap-x-5 gap-y-2">
                <div>
                  <dt class="text-2xs text-ink-faint">Sealed payload</dt>
                  <dd class="tnum mt-0.5 text-sm font-semibold text-ink">
                    {wireCapture.request.body.truncated
                      ? wireCapture.request.body.byteLength === null
                        ? `${formatBytes(wireCapture.request.body.capturedBytes)} captured`
                        : `${formatBytes(wireCapture.request.body.capturedBytes)} of ${formatBytes(wireCapture.request.body.byteLength)}`
                      : formatBytes(wireCapture.request.body.byteLength)}
                  </dd>
                </div>
                <div>
                  <dt class="text-2xs text-ink-faint">Fingerprint input</dt>
                  <dd class="tnum mt-0.5 text-sm font-semibold text-ink">{formatBytes(wireCapture.request.body.capturedBytes)}</dd>
                </div>
                <div>
                  <dt class="text-2xs text-ink-faint">Encrypted response</dt>
                  <dd class="tnum mt-0.5 text-sm font-semibold text-ink">{formatBytes(wireCapture.response?.body.byteLength)}</dd>
                </div>
                <div>
                  <dt class="text-2xs text-ink-faint">Enclave request</dt>
                  <dd class={cn("mt-0.5 truncate text-sm font-semibold text-ink", selectedRequest.tinfoilRequestId && "font-mono")}>{selectedRequest.tinfoilRequestId ?? "Pending"}</dd>
                </div>
              </dl>

              <div class="min-w-0 border-t border-line pt-3">
                <p class="text-2xs text-ink-faint">Encapsulated key</p>
                <p class="mt-0.5 truncate font-mono text-2xs text-ink-secondary" title={wireHeader("ehbp-encapsulated-key")}>{wireHeader("ehbp-encapsulated-key")}</p>
              </div>
            </div>
          </div>
        {/if}
      </section>

      <div class="space-y-4 px-4 py-4">
        <section aria-labelledby="metadata-title">
          <h3 id="metadata-title" class="mb-2 text-2xs font-semibold uppercase tracking-wider text-ink-faint">Request metadata</h3>
          <dl class="grid grid-cols-3 overflow-hidden rounded-[var(--radius-md)] border border-line bg-surface-2/40 text-xs">
          <div class="min-w-0 border-b border-r border-line p-2">
            <dt class="text-ink-faint">Route</dt>
            <dd class="mt-1 truncate font-mono text-ink" title={selectedRequest.path}>{selectedRequest.path}</dd>
          </div>
          {#if showModelDetails}
          <div class="min-w-0 border-b border-r border-line p-2">
            <dt class="text-ink-faint">Model</dt>
            <dd class="mt-1 truncate font-mono text-ink">{selectedRequest.model ?? "—"}</dd>
          </div>
          {/if}
          <div class="min-w-0 border-b border-line p-2">
            <dt class="text-ink-faint">Feature</dt>
            <dd class="mt-1 truncate text-ink">{selectedRequest.feature}</dd>
          </div>
          <div class="min-w-0 border-r border-line p-2">
            <dt class="text-ink-faint">Status</dt>
            <dd class={cn("mt-1 truncate font-medium capitalize", statusTone(selectedRequest))}>{requestStatus(selectedRequest)}</dd>
          </div>
          <div class="min-w-0 border-r border-line p-2">
            <dt class="text-ink-faint">Duration</dt>
            <dd class="tnum mt-1 text-ink">{formatDuration(latency(selectedRequest))}</dd>
          </div>
          <div class="min-w-0 p-2">
            <dt class="text-ink-faint">Started</dt>
            <dd class="tnum mt-1 truncate text-ink" title={formatTimestamp(selectedRequest.startedAt)}>{formatRelative(selectedRequest.startedAt, now)}</dd>
          </div>
          {#if selectedRequest.usage}
            <div class="col-span-3 flex items-center justify-between gap-3 border-t border-line px-2 py-1.5 text-2xs">
              <dt class="text-ink-faint">Token usage</dt>
              <dd class="tnum text-ink-secondary">{selectedRequest.usage.promptTokens} input · {selectedRequest.usage.completionTokens} output · {selectedRequest.usage.totalTokens} total</dd>
            </div>
          {/if}
          <div class="col-span-3 grid grid-cols-3 border-t border-line text-2xs">
            <div class="border-r border-line px-2 py-1.5">
              <dt class="text-ink-faint">Headers</dt>
              <dd class="tnum mt-0.5 text-ink-secondary">{phaseDuration(selectedRequest.responseHeadersAt, selectedRequest.startedAt)}</dd>
            </div>
            <div class="border-r border-line px-2 py-1.5">
              <dt class="text-ink-faint">First chunk</dt>
              <dd class="tnum mt-0.5 text-ink-secondary">{phaseDuration(selectedRequest.firstChunkAt, selectedRequest.startedAt)}</dd>
            </div>
            <div class="min-w-0 px-2 py-1.5">
              <dt class="text-ink-faint">Trace</dt>
              <dd class="mt-0.5 truncate font-mono text-ink-secondary" title={selectedRequest.traceId ?? ""}>{selectedRequest.traceId?.slice(0, 12) ?? "—"}</dd>
            </div>
          </div>
          </dl>
        </section>

        {#if wireCapture}
          <section aria-labelledby="raw-payload-title">
            <div class="mb-1.5 flex items-center justify-between gap-3">
              <div class="min-w-0">
                <h3 id="raw-payload-title" class="text-2xs font-semibold uppercase tracking-wider text-ink-faint">{wireCapture.request.body.truncated ? "Captured sealed payload prefix · Base64" : "Raw sealed payload · Base64"}</h3>
                <p class={cn("mt-0.5 text-2xs", wireCapture.request.body.truncated ? "text-warning" : "text-ink-tertiary")}>
                  {wireCapture.request.body.truncated
                    ? wireCapture.request.body.byteLength === null
                      ? `${formatBytes(wireCapture.request.body.capturedBytes)} captured · total size unavailable · incomplete`
                      : `${formatBytes(wireCapture.request.body.capturedBytes)} of ${formatBytes(wireCapture.request.body.byteLength)} captured · incomplete`
                    : `${formatBytes(wireCapture.request.body.capturedBytes)} complete capture`}
                </p>
              </div>
              <Button variant="ghost" size="sm" aria-label={wireCapture.request.body.truncated ? "Copy captured sealed payload prefix" : "Copy raw sealed payload"} onclick={() => void copyRawPayload()} class="no-drag">
                {#if rawCopyState === "copied"}<CheckIcon size={16} strokeWidth={1.75} aria-hidden="true" />{:else}<ClipboardIcon size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
                {rawCopyState === "copied" ? "Copied" : rawCopyState === "failed" ? "Copy failed" : wireCapture.request.body.truncated ? "Copy prefix" : "Copy raw"}
              </Button>
            </div>
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (The selectable payload must be keyboard-focusable.) -->
            <pre
              role="region"
              tabindex="0"
              aria-label={wireCapture.request.body.truncated ? "Captured sealed request payload prefix in Base64" : "Raw sealed request payload in Base64"}
              data-testid="raw-payload"
              class="m-0 min-h-14 w-full select-text whitespace-pre-wrap break-all rounded-[var(--radius-md)] border border-line bg-ink/[0.035] px-3 py-2 font-mono text-2xs leading-4 text-ink-secondary outline-none selection:bg-primary/20 focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {wireCapture.request.body.base64}
            </pre>
          </section>
        {/if}
      </div>

      </div>
      <div
        class={cn(
          "pointer-events-none absolute right-0.5 top-0 z-20 w-3 rounded-full bg-ink-faint/50 transition-opacity duration-150",
          detailsScrolling && detailsCanScroll ? "opacity-100" : "opacity-0",
        )}
        style={`height: ${detailsThumbHeight}px; transform: translateY(${detailsThumbTop}px);`}
        data-testid="request-scroll-thumb"
        aria-hidden="true"
      ></div>
        </div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>

<style>
  .request-detail-scroll {
    scrollbar-gutter: auto;
    scrollbar-width: none;
  }

  .request-detail-scroll::-webkit-scrollbar {
    display: none;
    width: 0;
    height: 0;
  }
</style>
