<script lang="ts">
	import type { HTMLSelectAttributes } from 'svelte/elements';

	type Option = {
		value: string;
		label: string;
	};
	type Props = Omit<HTMLSelectAttributes, 'class' | 'value' | 'disabled'> & {
		value?: string;
		options?: readonly Option[];
		disabled?: boolean;
		class?: string;
	};

	let {
		value = $bindable(''),
		options = [],
		disabled = false,
		class: cls = '',
		...rest
	}: Props = $props();
</script>

<select
	bind:value
	{disabled}
	class="h-9 rounded-[var(--radius-md)] border border-line bg-surface-2 px-3 text-base text-ink outline-none transition-colors focus:border-line-strong disabled:cursor-not-allowed disabled:opacity-40 {cls}"
	{...rest}
>
	{#each options as option (option.value)}
		<option value={option.value}>{option.label}</option>
	{/each}
</select>
