<script lang="ts">
  import { Toaster, type ToasterProps } from "svelte-sonner";

  let {
    position = "bottom-left",
    closeButton = true,
    richColors = true,
    expand = false,
    visibleToasts = 3,
    theme = "light",
    compact = false,
    style = "",
    ...restProps
  }: ToasterProps & { compact?: boolean } = $props();
</script>

<Toaster
  {position}
  {closeButton}
  {richColors}
  {expand}
  {visibleToasts}
  {theme}
  offset={compact ? 12 : 32}
  mobileOffset={12}
  class={`toaster ambient-notification-toaster group ${compact ? "ambient-compact-toaster" : ""}`}
  style={`--normal-bg: var(--elevated); --normal-text: var(--ink); --normal-border: var(--line); --success-bg: var(--elevated); --success-text: var(--ink); --success-border: var(--line); --error-bg: var(--elevated); --error-text: var(--ink); --error-border: color-mix(in srgb, var(--danger) 46%, var(--line)); --warning-bg: var(--elevated); --warning-text: var(--ink); --warning-border: color-mix(in srgb, var(--warning) 46%, var(--line)); --info-bg: var(--elevated); --info-text: var(--ink); --info-border: var(--line); ${style}`}
  {...restProps}
/>

<style>
  /* Match the App's 244px sidebar minus its two 12px gutters. */
  :global(.ambient-compact-toaster[data-sonner-toaster]) {
    --width: min(220px, calc(100vw - 24px)) !important;
    width: var(--width);
    font-family: var(--font-sans);
  }
  :global(.ambient-compact-toaster [data-sonner-toast][data-styled="true"]) {
    width: var(--width);
    padding: 0.875rem;
    gap: 0.5rem;
    align-items: flex-start;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    color: var(--ink);
    font-size: var(--text-sm);
    box-shadow: 0 1px 2px color-mix(in oklch, var(--scrim) 5%, transparent),
      0 1px 1px color-mix(in oklch, var(--scrim) 4%, transparent);
  }
  :global(.ambient-compact-toaster [data-title]) { line-height: 1.375; }
  :global(.ambient-compact-toaster [data-icon]) { margin-top: 1px; }
  :global(.ambient-compact-toaster [data-description]) {
    color: var(--ink-secondary);
    font-size: var(--text-xs);
  }
  :global(.ambient-compact-toaster [data-testid="ambient-action-toast"]) { width: var(--width); }
</style>
