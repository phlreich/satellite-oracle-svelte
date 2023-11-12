<!-- svelte-ignore a11y-no-static-element-interactions -->
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

	async function runQuery(query: string) {
		try {
			const response = await fetch('/api/query', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ query })
			});

			if (!response.ok) {
				throw new Error(`HTTP error! Status: ${response.status}`);
			}

			const data = await response.json();
			return data;
		} catch (error) {
			console.error('Error running query: ', error);
		}
	}
	async function handleKeyUp(event: { key: string }) {
		if (event.key === 'Enter') {
			console.log('Running query:', $inputValue);
			const result = await runQuery($inputValue);
			console.log('Query result:', result);
		}
	}
</script>

<svelte:head>
	<title>Satellite Oracle</title>
	<meta name="description" content="The satellite oracle will see you now." />
</svelte:head>

<canvas bind:this={el}></canvas>

<!-- Floating info panel for selected satellite -->
<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="satellite-info {$selectedSatellite ? 'visible' : 'hidden'}" on:click|stopPropagation>
	{#if $selectedSatellite}
		<!-- Display your satellite information here -->
		<h2>{$selectedSatellite.name}</h2>
		<pre>{$selectedSatellite.details}</pre>
	{/if}
</div>

<!-- Floating input field -->
<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="input-field" on:click|stopPropagation>
	<input type="text" bind:value={$inputValue} placeholder="Type something..." on:keyup={handleKeyUp}/>
</div>

<style>
	.input-field {
		position: absolute;
		bottom: 10px;
		right: 10px;
		width: 500px;
		color: white;
		background: rgba(0, 0, 0, 0.9);
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
		background: rgba(0, 0, 0, 0.9);
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
