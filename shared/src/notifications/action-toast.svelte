<script lang="ts">
  import { Button } from "@ambient/shared/ui/button";
  import type { AmbientUpdateProgressView } from "./index.js";
  import type { AmbientToastAction, AmbientToastVariant } from "./types";
  import AmbientUpdateProgress from "./update-progress.svelte";

  let {
    title,
    description = null,
    detail = null,
    variant = "info",
    actions = [],
    progress = null,
    closeToast = () => {},
  }: {
    readonly title: string;
    readonly description?: string | null;
    readonly detail?: string | null;
    readonly variant?: AmbientToastVariant;
    readonly actions?: readonly AmbientToastAction[];
    readonly progress?: AmbientUpdateProgressView | null;
    readonly closeToast?: () => void;
  } = $props();

  let busyAction = $state<string | null>(null);

  async function runAction(action: AmbientToastAction): Promise<void> {
    if (busyAction) return;
    busyAction = action.label;
    try {
      await action.onClick?.();
      closeToast();
    } finally {
      busyAction = null;
    }
  }

  const toneVariant = {
    primary: "primary",
    secondary: "secondary",
    ghost: "ghost",
  } as const;
</script>

<!-- Toast width is a layout constant (fit viewport with 32px inset); shadow is the toast's own elevation. -->
<div
  data-testid="ambient-action-toast"
  class="grid w-[min(360px,calc(100vw-32px))] gap-3 overflow-hidden rounded-[var(--radius-lg)] border border-line bg-elevated p-3.5 text-ink shadow-[0_18px_60px_rgb(0_0_0/0.25)] data-[variant=success]:border-success/40 data-[variant=warning]:border-warning/45 data-[variant=loading]:border-warning/45 data-[variant=error]:border-danger/45"
  data-variant={variant}
>
  <div class="grid min-w-0 gap-1.5">
    <strong class="text-sm font-semibold leading-tight [overflow-wrap:anywhere]">{title}</strong>
    {#if description}
      <p class="text-sm leading-snug text-ink-secondary [overflow-wrap:anywhere]">{description}</p>
    {/if}
    {#if detail}
      <p class="text-xs text-ink-secondary [overflow-wrap:anywhere]">{detail}</p>
    {/if}
    {#if progress}
      <AmbientUpdateProgress percent={progress.percent} label={progress.label} />
    {/if}
  </div>

  {#if actions.length > 0}
    <div class="flex flex-wrap gap-2" aria-label="Notification actions">
      {#each actions as action (action.label)}
        <Button type="button" size="sm" variant={toneVariant[action.tone ?? "secondary"]} disabled={busyAction !== null} onclick={() => void runAction(action)} class="no-drag">
          {busyAction === action.label ? "Working…" : action.label}
        </Button>
      {/each}
    </div>
  {/if}
</div>
