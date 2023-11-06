<!-- src/routes/oracle/+page.svelte -->
<script lang="ts">
	import type { PageData } from './$types';
	import { onMount, onDestroy } from 'svelte';
	import { createScene } from '$lib/scene';
	import { writable } from 'svelte/store';

	export let data: PageData;
	let el: HTMLCanvasElement;
	let cleanup: () => void;

	// Reactive variable to hold selected satellite info
	const selectedSatellite = writable<{ name: string; details: object } | null>(null);
	const inputValue = writable('');
	onMount(() => {
		createScene(el, data.sceneData, selectedSatellite).then((cleanupFunction) => {
			cleanup = cleanupFunction;
		});
	});

	onDestroy(() => {
		if (cleanup) cleanup();
	});
</script>

<svelte:head>
	<title>Satellite Oracle</title>
	<meta name="description" content="The satellite oracle will see you now." />
</svelte:head>

<canvas bind:this={el}></canvas>

<!-- Floating info panel for selected satellite -->
<div class="satellite-info {$selectedSatellite ? 'visible' : 'hidden'}" on:click|stopPropagation>
	{#if $selectedSatellite}
		<!-- Display your satellite information here -->
		<h2>{$selectedSatellite.name}</h2>
		<pre>{$selectedSatellite.details}</pre>
	{/if}
</div>

<!-- Floating input field -->
<div class="input-field" on:click|stopPropagation>
	<input type="text" bind:value={$inputValue} placeholder="Type something..." />
</div>

<style>
	.input-field {
		position: absolute;
		bottom: 10px;
		right: 10px;
		width: 500px;
		color: white;
		background: rgba(0, 0, 0, 0.5);
		padding: 10px;
		border-radius: 5px;
		border: 1px solid white;
	}
	.input-field input::placeholder {
		color: #ccc; /* Adjust as needed */
	}

	.input-field input {
		color: white;
		background: transparent;
		border: none;
		outline: none;
		font-size: larger;
	}

	.satellite-info {
		position: absolute;
		min-width: 500px;
		bottom: 10px;
		left: 10px;
		color: white;
		background: rgba(0, 0, 0, 0.5);
		padding: 10px;
		border-radius: 5px;
		border: 1px solid white;
	}
	.visible {
		display: block;
	}

	.hidden {
		display: none;
	}
</style>
