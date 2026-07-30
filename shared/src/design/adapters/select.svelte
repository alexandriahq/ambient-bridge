<script lang="ts">
	import { cn } from '../cn.js';

	type Option = {
		value: string;
		label: string;
	};

	type Props = {
		value?: string;
		options?: readonly Option[];
		disabled?: boolean;
		class?: string;
		'aria-label'?: string;
		onValueChange?: (value: string) => void;
	};

	let {
		value = $bindable(''),
		options = [],
		disabled = false,
		class: className = '',
		'aria-label': ariaLabel,
		onValueChange
	}: Props = $props();

	$effect(() => {
		if (options.length === 0 || options.some((option) => option.value === value)) return;
		selectValue(options[0].value);
	});

	function selectValue(nextValue: string): void {
		value = nextValue;
		onValueChange?.(nextValue);
	}
</script>

<select
	bind:value
	{disabled}
	aria-label={ariaLabel}
	onchange={(event) => selectValue((event.currentTarget as HTMLSelectElement).value)}
	class={cn(
		'h-9 w-full min-w-0 cursor-pointer rounded-[var(--radius-md)] border border-line bg-surface-2 px-3 text-base text-ink outline-none transition-colors hover:bg-surface-3 focus-visible:border-line-strong disabled:cursor-not-allowed disabled:opacity-40',
		className
	)}
>
	{#each options as option (option.value)}
		<option value={option.value}>{option.label}</option>
	{/each}
</select>
