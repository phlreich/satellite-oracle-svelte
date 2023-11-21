<!-- svelte-ignore a11y-no-static-element-interactions -->
<!-- src/routes/oracle/+page.svelte -->
<script lang="ts">
	import type { PageData } from './$types';
	import { onMount, onDestroy } from 'svelte';
	import { createScene } from '$lib/scene';
	import { writable } from 'svelte/store';
	import type { ChatCompletionMessage } from 'openai/resources';

	export let data: PageData;
	let el: HTMLCanvasElement;
	let cleanup: () => void;

	interface UserMessage {
		role: 'user';
		content: string | null;
	}

	interface ToolMessage {
		role: 'tool';
		content: string | null;
		tool_call_id: string;
	}

	type Message = ChatCompletionMessage | UserMessage | ToolMessage;

	let chatHistory: Message[] = [];

	const sharedData = writable(Array<any>());

	// Reactive variable to hold selected satellite info
	const selectedSatellite = writable<{ name: string; details: object } | null>(null);
	const inputValue = writable('');
	onMount(() => {
		createScene(el, data.sceneData, selectedSatellite, sharedData).then((cleanupFunction) => {
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

	async function aiChat(chatHistory: Message[]) {
		try {
			const response = await fetch('/api/ai-chat', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ chatHistory })
			});

			if (!response.ok) {
				throw new Error(`HTTP error! Status: ${response.status}`);
			}

			const data = await response.json();
			return data;
		} catch (error) {
			console.error('Error calling aiChat: ', error);
		}
	}

	async function handleKeyUp(event: { key: string }) {
		if (event.key === 'Enter') {
			console.log($inputValue);
			let userChatInput = $inputValue;
			chatHistory.push({ role: 'user', content: userChatInput });
			$inputValue = '';
			let result = await aiChat(chatHistory);
			result = JSON.parse(result);
			if (result.choices[0]) {
				(window as any).result = result;
				chatHistory.push(result.choices[0].message);
			}
			// if it is a function call, run it and send the data to the scene
			if (result.choices[0].message.tool_calls) {
				const args = JSON.parse(result.choices[0].message.tool_calls[0].function.arguments);
				console.log('Query:', args.query);
				let data;
				try {
					data = await runQuery(args.query);
					(window as any).data = data;
				} catch (error) {
					console.error('Error running query: ', error);
				}
				data = JSON.parse(data);
				sharedData.set([data, args.intent]);
				chatHistory.push({
					role: 'tool',
					content: 'SQL query executed',
					tool_call_id: result.choices[0].message.tool_calls[0].id
				});
			} else {
				// if it is not a function call, just send the message to the scene
				console.log(result.choices[0].message.content);
			}
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
	<textarea bind:value={$inputValue} placeholder="Type anything..." on:keyup={handleKeyUp}
	></textarea>
</div>

<style>
	.input-field {
		position: absolute;
		bottom: 10px;
		right: 10px;
		color: white;
		background: rgba(0, 0, 0, 0.9);
		padding: 10px;
		border-radius: 5px;
		border: 1px solid white;
	}
	.input-field textarea::placeholder {
		color: #ccc;
	}

	.input-field textarea {
		color: white;
		background: transparent;
		border: none;
		outline: none;
		font-size: larger;
		width: 500px; /* Adjust as needed */
		height: auto; /* Initial height, will expand */
		overflow-y: hidden; /* Hide vertical scrollbar */
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
