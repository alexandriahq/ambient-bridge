<script lang="ts">
  import Button from "../ui/Button.svelte";
  import { cn } from "../cn";
  import type { SessionGuardCardModel, SessionGuardStatus } from "../../session-guard.js";

  let {
    model,
    onAction,
    compact = false,
  }: {
    readonly model: SessionGuardCardModel;
    readonly onAction?: (actionId: string) => void;
    readonly compact?: boolean;
  } = $props();

  const rows = $derived(model.rows ?? []);
  const actions = $derived(model.actions ?? []);
  const nextSteps = $derived(model.nextSteps ?? []);

  function dotClass(status: SessionGuardStatus): string {
    switch (status) {
      case "ready":
        return "bg-success";
      case "checking":
        return "bg-primary";
      case "failed":
        return "bg-danger";
      default:
        return "bg-warning";
    }
  }

  function handleAction(actionId: string): void {
    onAction?.(actionId);
  }
</script>

{#snippet spinner()}
  <span class="inline-block size-3 animate-spin rounded-full border-[1.5px] border-current border-r-transparent"></span>
{/snippet}

<section class={cn("grid w-[min(100%,560px)] text-ink", compact ? "gap-5" : "gap-7")} aria-labelledby="session-guard-title">
  <header class={compact ? "grid gap-2" : "grid gap-3"}>
    {#if model.eyebrow}
      <p class="text-xs font-bold uppercase tracking-wider text-ink-secondary">{model.eyebrow}</p>
    {/if}
    <h1 id="session-guard-title" class="text-lg font-bold leading-none tracking-tight">
      {model.title}
    </h1>
    <p class="text-base leading-relaxed text-ink-secondary">{model.message}</p>
    {#if model.detail && !compact}
      <p class="text-sm leading-relaxed text-ink-secondary">{model.detail}</p>
    {/if}
  </header>

  {#if rows.length > 0}
    <ul class="grid" aria-label="Session checks">
      {#each rows as row (row.id)}
        <li class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-t border-line py-3 first:border-t-0">
          <span class={cn("size-[7px] flex-none rounded-full", dotClass(row.status))} aria-hidden="true"></span>
          <span class="min-w-0 text-sm font-semibold">{row.label}</span>
          <span class="whitespace-nowrap text-sm text-ink-secondary">{row.value}</span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if actions.length > 0}
    <div class="flex flex-wrap gap-2.5">
      {#each actions as action (action.id)}
        <Button
          variant={action.variant === "secondary" ? "secondary" : "primary"}
          size={compact ? "md" : "lg"}
          disabled={action.disabled || action.busy}
          onclick={() => handleAction(action.id)}
        >
          {#if action.busy}
            {@render spinner()}
          {/if}
          {action.label}
        </Button>
      {/each}
    </div>
  {/if}

  {#if nextSteps.length > 0 && !compact}
    <ul class="grid gap-1.5 text-sm leading-relaxed text-ink-secondary">
      {#each nextSteps as step}
        <li class="relative pl-4 before:absolute before:left-0.5 before:top-[0.6em] before:size-1 before:rounded-full before:bg-current before:opacity-60">{step}</li>
      {/each}
    </ul>
  {/if}
</section>
