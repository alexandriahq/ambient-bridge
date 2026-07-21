<script lang="ts">
  import Button from "../design/ui/Button.svelte";
  import type { AmbientActionToastInput } from "./index.js";
  import type { AmbientToastAction } from "./types.js";

  // Docked-card presentation of the same notification content the toasts
  // render — used by surfaces that own a sidebar (Ambient App) instead of the
  // floating toast layer.
  let {
    content,
    onDismiss = () => {},
  }: {
    readonly content: AmbientActionToastInput;
    readonly onDismiss?: () => void;
  } = $props();

  let busyAction = $state<string | null>(null);

  const updateAction = $derived((content.actions ?? []).find((action) => action.label === "Update"));
  const laterAction = $derived((content.actions ?? []).find((action) => action.label === "Later"));
  const releaseNotesAction = $derived((content.actions ?? []).find((action) => action.label === "See what's new."));
  const readyToUpdate = $derived(Boolean(updateAction && laterAction));

  async function runAction(action: AmbientToastAction, dismissAfter = true): Promise<void> {
    if (busyAction) return;
    busyAction = action.label;
    try {
      await action.onClick?.();
      if (dismissAfter) onDismiss();
    } finally {
      busyAction = null;
    }
  }
</script>

<div
  data-testid="ambient-update-card"
  class="grid w-full max-w-full min-w-0 gap-3 overflow-hidden rounded-[var(--radius-lg)] border border-line bg-elevated p-3 text-ink shadow-[0_10px_30px_rgb(0_0_0/0.10)] data-[variant=warning]:border-warning/45 data-[variant=loading]:border-warning/45 data-[variant=error]:border-danger/45"
  data-variant={content.variant ?? "info"}
>
  <strong class="min-w-0 text-sm font-semibold leading-tight [overflow-wrap:anywhere]">{content.title}</strong>

  {#if readyToUpdate}
    <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs leading-tight text-ink-secondary">
      {#if content.description}<span>{content.description}</span>{/if}
      {#if releaseNotesAction}
        <button
          type="button"
          class="cursor-pointer font-medium text-ink-secondary underline decoration-ink-secondary/70 underline-offset-2 hover:text-ink"
          disabled={busyAction !== null}
          onclick={() => void runAction(releaseNotesAction, false)}
        >
          {releaseNotesAction.label}
        </button>
      {/if}
    </div>

    <div class="grid min-w-0 grid-cols-2 gap-2" aria-label="Update actions">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        full
        disabled={busyAction !== null}
        onclick={() => void runAction(laterAction!)}
      >
        {busyAction === laterAction!.label ? "Working…" : laterAction!.label}
      </Button>
      <Button
        type="button"
        variant="primary"
        size="sm"
        full
        class="text-white hover:brightness-95"
        style="background-color: #0168C9"
        disabled={busyAction !== null}
        onclick={() => void runAction(updateAction!)}
      >
        {busyAction === updateAction!.label ? "Updating…" : updateAction!.label}
      </Button>
    </div>
  {:else}
    {#if content.description}
      <!-- -webkit-line-clamp truncates the description to two lines; no primitive covers line-clamping -->
      <p class="m-0 line-clamp-2 overflow-hidden text-xs leading-tight text-ink-secondary [overflow-wrap:anywhere]">{content.description}</p>
    {/if}
    {#if content.detail}
      <p class="m-0 text-xs leading-tight text-ink-secondary [overflow-wrap:anywhere]">{content.detail}</p>
    {/if}
    {#if content.actions?.length}
      <div class="flex min-w-0 flex-wrap gap-2" aria-label="Notification actions">
        {#each content.actions as action (action.label)}
        <Button
          variant={action.tone === "primary" ? "primary" : action.tone === "ghost" ? "ghost" : "secondary"}
          size="sm"
          disabled={busyAction !== null}
          onclick={() => void runAction(action)}
        >
          {busyAction === action.label ? "Working…" : action.label}
        </Button>
        {/each}
      </div>
    {/if}
  {/if}
</div>
