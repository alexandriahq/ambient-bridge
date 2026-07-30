<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	type Props = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
		class?: string;
		children?: Snippet;
	};

	let { class: cls = '', children, ...rest }: Props = $props();
</script>

<div class="card {cls}" {...rest}>
	{@render children?.()}
</div>
