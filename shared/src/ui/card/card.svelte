<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from "@ambient/shared/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		children,
		size = "default",
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & { size?: "default" | "sm" } = $props();
</script>

<div
	bind:this={ref}
	data-slot="card"
	data-size={size}
	class={cn(
		"bg-card text-card-foreground border-border rounded-[var(--radius-xl)] border [--card-spacing:--spacing(4)] data-[size=sm]:[--card-spacing:--spacing(3)] group/card",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
