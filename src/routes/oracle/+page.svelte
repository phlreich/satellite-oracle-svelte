<!-- svelte-ignore a11y-no-static-element-interactions -->
<!-- src/routes/oracle/+page.svelte -->
<script lang="ts">
	import type { PageData } from './$types';
	import { onMount, onDestroy, tick } from 'svelte';
	import { createScene } from '$lib/scene';
	import { writable, get } from 'svelte/store';
	import { isMobile } from '$lib/utils';
	import type { ChatCompletionMessage } from 'openai/resources';
	import { eciToGeodetic, gstime, propagate, degreesLat, degreesLong } from 'satellite.js';

	let chatWindow: HTMLDivElement;
	let startX: number, startY: number, startWidth: number, startHeight: number;

	const initDrag = (e: MouseEvent) => {
		startX = e.clientX;
		startY = e.clientY;
		startWidth = parseInt(document.defaultView?.getComputedStyle(chatWindow).width ?? '300', 10);
		startHeight = parseInt(document.defaultView?.getComputedStyle(chatWindow).height ?? '150', 10);
		document.documentElement.addEventListener('mousemove', doDrag, false);
		document.documentElement.addEventListener('mouseup', stopDrag, false);
	};

	const minWidth = 300;
	const minHeight = 130;

	const doDrag = (e: MouseEvent) => {
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;

		const newWidth = startWidth - dx;
		const newHeight = startHeight - dy;

		chatWindow.style.width = Math.max(newWidth, minWidth) + 'px';
		chatWindow.style.height = Math.max(newHeight, minHeight) + 'px';
	};

	const stopDrag = () => {
		document.documentElement.removeEventListener('mousemove', doDrag, false);
		document.documentElement.removeEventListener('mouseup', stopDrag, false);
	};

	let messageContainer: HTMLElement;

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

	const chatHistory = writable<Message[]>([]);

	function resetChat() {
		chatHistory.set([]);
	}

	function getChatHistory() {
		return get(chatHistory);
	}

	(window as any).getChatHistory = getChatHistory;
	const sharedData = writable(Array<any>());

	// Reactive variable to hold selected satellite info
	const selectedSatellite = writable<{
		name: string;
		details: object;
		latitude: number;
		longitude: number;
		index: number;
		satrec: any;
	} | null>(null);
	const inputValue = writable('');
	let isMobileView = false;
	onMount(() => {
		const userAgent = typeof window !== 'undefined' ? window.navigator.userAgent : null;
		isMobileView = isMobile(userAgent);
		createScene(el, data.sceneData, selectedSatellite, sharedData).then((cleanupFunction) => {
			cleanup = cleanupFunction;
		});

		chatWindow.addEventListener('mousedown', initDrag, false);
		const setInterval = window.setInterval(() => {
			updateLatLong();
		}, 1000);
		typeText('Show all American non-debris objects launched before 2009', 100);
	});

	onDestroy(() => {
		chatWindow.removeEventListener('mousedown', initDrag, false);
		if (cleanup) cleanup();
	});

	function typeText(text: string, delay = 100) {
		let i = 0;
		const interval = setInterval(() => {
			$inputValue += text[i];
			i++;
			if (i >= text.length) {
				clearInterval(interval);
				handleKeyUp({ key: 'Enter' });
			}
		}, delay);
	}

	function updateLatLong() {
		if ($selectedSatellite) {
			const now = new Date();
			const positionAndVelocity = propagate($selectedSatellite.satrec, now);
			const positionEci = positionAndVelocity.position;
			const gmst = gstime(now);
			if (typeof positionEci === 'boolean') throw 'Error propagating satellite position';
			const positionGd = eciToGeodetic(positionEci, gmst);
			$selectedSatellite.latitude = degreesLat(positionGd.latitude);
			$selectedSatellite.longitude = degreesLong(positionGd.longitude);
		}
	}

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
			// console.log('Error calling runQuery: ', error)
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
			// console.error('Error calling aiChat: ', error);
		}
	}

	async function handleKeyUp(event: { key: string }) {
		if (
			event.key === 'Enter' &&
			(get(chatHistory).length === 0 || get(chatHistory).slice(-1)[0].role !== 'user')
		) {
			// console.log($inputValue);
			let userChatInput = $inputValue;
			chatHistory.update((history) => {
				return [...history, { role: 'user', content: userChatInput }];
			});
			$inputValue = '';
			await tick();
			messageContainer.scrollTop = messageContainer.scrollHeight;
			let result = await aiChat($chatHistory);
			result = JSON.parse(result);
			if (result.choices[0]) {
				// (window as any).result = result;
				chatHistory.update((history) => {
					return [...history, result.choices[0].message];
				});
			}
			// if it is a function call, run it and send the data to the scene
			if (result.choices[0].message.tool_calls) {
				const args = JSON.parse(result.choices[0].message.tool_calls[0].function.arguments);
				// console.log('Query:', args.query);

				let data = await runQuery(args.query);
				data = JSON.parse(data);
				// (window as any).data = data;

				// if there is an error TODO: handle this better
				if (data.code === 'SQLITE_ERROR') {
					// console.error('Error running query: ', data.error);
					chatHistory.update((history) => {
						return [
							...history,
							{
								role: 'tool',
								content: 'Query failed, SQL error: ' + data.error_message,
								tool_call_id: result.choices[0].message.tool_calls[0].id
							}
						];
					});
					return;
				}
				if (data.code === 'NO_ROWS') {
					// console.error('Error running query: ', data.error);
					chatHistory.update((history) => {
						return [
							...history,
							{
								role: 'tool',
								content: 'Query failed, no results found.',
								tool_call_id: result.choices[0].message.tool_calls[0].id
							}
						];
					});
					return;
				}
				if (data.code === 'SyntaxError') {
					chatHistory.update((history) => {
						return [
							...history,
							{
								role: 'tool',
								content: 'Query failed, syntax error: ' + data.error_message,
								tool_call_id: result.choices[0].message.tool_calls[0].id
							}
						];
					});
					return;
				}
				sharedData.set([data, args.intent]);
				chatHistory.update((history) => {
					return [
						...history,
						{
							role: 'tool',
							content: 'Query run successfully. ' + args.retranslation,
							tool_call_id: result.choices[0].message.tool_calls[0].id
						}
					];
				});
			} else {
				// TODO think about how to handle this
			}
			await tick();
			messageContainer.scrollTop = messageContainer.scrollHeight;
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
		{#if typeof $selectedSatellite.longitude === 'number' && typeof $selectedSatellite.latitude === 'number'}
			<pre>Latitude:   {$selectedSatellite.latitude.toFixed(2)}°</pre>
			<pre>Longitude:  {$selectedSatellite.longitude.toFixed(2)}°</pre>
		{/if}
		<!-- <pre>{$selectedSatellite.details}</pre> -->
	{/if}
</div>

<!-- Floating input field -->
<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div
	bind:this={chatWindow}
	class="chat-window {isMobileView ? 'hidden' : ''}"
	on:click|stopPropagation
>
	<div bind:this={messageContainer} class="message-container">
		{#each $chatHistory as message}
			{#if message.content != null}
				<div class="message {message.role}">
					{message.content}
				</div>
			{/if}
		{/each}
	</div>
	<div class="input-area">
		<textarea
			class="input-field"
			bind:value={$inputValue}
			placeholder="Type anything..."
			on:keyup={handleKeyUp}
		></textarea>
		<button class="reset-button" on:click={resetChat}>Reset Chat</button>
	</div>
</div>

<style>
	textarea {
		resize: none;
	}

	.chat-window {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		position: absolute;
		bottom: 10px;
		right: 10px;
		color: white;
		background: rgba(0, 0, 0, 0.8);
		padding: 15px;
		border-radius: 10px;
		box-shadow: 0 4px 8px rgba(0, 0, 0, 0.5);
		max-height: 60vh;
		max-width: calc(100vw - 590px);
		overflow: hidden;
		width: 550px;
		height: 350px;
		border: 1px solid white;
		font-size: x-large;
	}

	.message-container {
		overflow-y: auto;
		flex-grow: 1;
		margin-bottom: 15px;
	}

	.input-field {
		color: white;
		background: rgba(0, 0, 0, 0.9);
		padding: 10px;
		margin-right: 10px;
		padding-right: 10px;
		border-radius: 5px;
		border: 1px solid #ccc;
		font-size: x-large;
		width: 100%;
		box-sizing: border-box;
	}

	.input-field,
	.reset-button {
		outline: none;
		height: 100%;
	}

	.input-area {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.message {
		background: #556272;
		border-radius: 10px;
		padding: 10px;
		margin-bottom: 10px;
		word-wrap: break-word;
	}

	.message.user {
		background: #2a5562;
		text-align: right;
	}

	.reset-button {
		padding: 5px 15px;
		border-radius: 5px;
		border: 1px solid #ccc;
		color: white;
		background: rgba(0, 0, 0, 0.9);
		cursor: pointer;
		outline: none;
		font-size: medium;
	}

	.reset-button:hover {
		background-color: #232121; /* Change background on hover */
		border-color: #aaa;
	}

	.satellite-info {
		position: absolute;
		min-width: 350px;
		max-width: 99vw;
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
