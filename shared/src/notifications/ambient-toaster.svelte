<script lang="ts">
  import { Toaster, type ToasterProps } from "svelte-sonner";

  let {
    position = "bottom-left",
    closeButton = true,
    richColors = true,
    expand = false,
    visibleToasts = 3,
    theme = "light",
    ...restProps
  }: ToasterProps = $props();
</script>

<Toaster
  {position}
  {closeButton}
  {richColors}
  {expand}
  {visibleToasts}
  {theme}
  class="toaster ambient-notification-toaster group"
  style="--normal-bg: hsl(var(--elevated)); --normal-text: hsl(var(--ink)); --normal-border: hsl(var(--line)); --success-bg: hsl(var(--elevated)); --success-text: hsl(var(--ink)); --success-border: color-mix(in srgb, hsl(var(--success)) 42%, hsl(var(--line))); --error-bg: hsl(var(--elevated)); --error-text: hsl(var(--ink)); --error-border: color-mix(in srgb, hsl(var(--danger)) 46%, hsl(var(--line))); --warning-bg: hsl(var(--elevated)); --warning-text: hsl(var(--ink)); --warning-border: color-mix(in srgb, hsl(var(--warning)) 46%, hsl(var(--line))); --info-bg: hsl(var(--elevated)); --info-text: hsl(var(--ink)); --info-border: hsl(var(--line));"
  {...restProps}
/>
