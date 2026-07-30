<script lang="ts">
	import type { Snippet } from 'svelte';

	type Props = {
		children?: Snippet;
	};

	let { children }: Props = $props();
</script>

<kbd
	class="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-line-strong bg-surface px-1 font-sans text-2xs font-medium text-ink-tertiary shadow-[0_1px_0_hsl(var(--line))]"
>
	{@render children?.()}
</kbd>
