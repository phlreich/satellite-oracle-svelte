<!-- src/routes/oracle/+page.svelte -->
<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { createScene } from '$lib/scene';
	import { writable, get } from 'svelte/store';
	import { isMobile } from '$lib/utils';
	import type { SatRec } from 'satellite.js';
	import { eciToGeodetic, gstime, propagate, degreesLat, degreesLong } from 'satellite.js';
	import { base } from '$app/paths';

	let chatWindow: HTMLDivElement;
	let startX: number, startY: number, startWidth: number, startHeight: number;
	let isDragging = false;
	let verticalDragOnly = false;
	let horizontalDragOnly = false;
	const minWidth = 300;
	const minHeight = 130;

	const borderSize = 10; // Size of the border region in pixels

	const initDrag = (e: MouseEvent) => {
		const rect = chatWindow.getBoundingClientRect();
		const isLeft = e.clientX - rect.left <= borderSize;
		const isRight = rect.right - e.clientX <= borderSize;
		const isTop = e.clientY - rect.top <= borderSize;
		const isBottom = rect.bottom - e.clientY <= borderSize;

		if (isLeft || isRight || isTop || isBottom) {
			if ((isLeft || isRight) && !(isTop || isBottom)) {
				horizontalDragOnly = true;
			}
			if (!(isLeft || isRight) && (isTop || isBottom)) {
				verticalDragOnly = true;
			}
			isDragging = true;
			startX = e.clientX;
			startY = e.clientY;
			startWidth = parseInt(getComputedStyle(chatWindow).width);
			startHeight = parseInt(getComputedStyle(chatWindow).height);
			document.documentElement.addEventListener('mousemove', doDrag, false);
			document.documentElement.addEventListener('mouseup', stopDrag, false);
		}
	};

	const doDrag = (e: MouseEvent) => {
		const dx = Number(!verticalDragOnly) * (e.clientX - startX); // Only allow horizontal drag delta if verticalDragOnly is false
		const dy = Number(!horizontalDragOnly) * (e.clientY - startY); // Only allow vertical drag delta if horizontalDragOnly is false

		const newWidth = startWidth - dx;
		const newHeight = startHeight - dy;

		chatWindow.style.width = Math.max(newWidth, minWidth) + 'px';
		chatWindow.style.height = Math.max(newHeight, minHeight) + 'px';
	};

	const stopDrag = () => {
		isDragging = false;
		verticalDragOnly = false;
		horizontalDragOnly = false;
		chatWindow.style.cursor = 'default';
		document.documentElement.removeEventListener('mousemove', doDrag, false);
		document.documentElement.removeEventListener('mouseup', stopDrag, false);
	};

	const updateCursor = (e: MouseEvent) => {
		if (isDragging) return;
		const rect = chatWindow.getBoundingClientRect();
		const isLeft = e.clientX - rect.left <= borderSize;
		const isRight = rect.right - e.clientX <= borderSize;
		const isTop = e.clientY - rect.top <= borderSize;
		const isBottom = rect.bottom - e.clientY <= borderSize;

		if (isLeft || isRight || isTop || isBottom) {
			if (isTop && isLeft) chatWindow.style.cursor = 'nwse-resize';
			else if (isTop && isRight) chatWindow.style.cursor = 'nesw-resize';
			else if (isBottom && isLeft) chatWindow.style.cursor = 'nesw-resize';
			else if (isBottom && isRight) chatWindow.style.cursor = 'nwse-resize';
			else if (isLeft || isRight) chatWindow.style.cursor = 'ew-resize';
			else if (isTop || isBottom) chatWindow.style.cursor = 'ns-resize';
		} else {
			chatWindow.style.cursor = 'default';
		}
	};

	let messageContainer: HTMLElement;
	let latLongIntervalId: number | undefined;

	let el: HTMLCanvasElement;
	let cleanup: (() => void) | undefined;
	let focusPreviousVisibleSatellite = () => {};
	let focusNextVisibleSatellite = () => {};
	let getVisibleCount = () => 0;
	let focusEarth = () => false;
	let focusVisibleNoradId = (_noradCatId: number) => false;

	type Message = {
		role: 'user' | 'assistant';
		content: string;
	};
	type SharedSceneIntent = 'replace' | 'add' | 'remove';
	type SharedSceneData = [Array<{ NORAD_CAT_ID: number }>, SharedSceneIntent] | [];
	type SceneDataRow = [string, string, string, number, string];
	type AssistResponseBody = {
		assistantMessage: string;
		action: {
			visibility?: {
				mode: 'replace' | 'add' | 'remove';
				noradCatIds: number[];
				returnedCount: number;
			};
			focus?:
				| {
						target: 'earth';
				  }
				| {
						target: 'norad';
						noradCatId: number;
				  };
		} | null;
	};

	const chatHistory = writable<Message[]>([]);

	function resetChat() {
		chatHistory.set([]);
	}

	const sharedData = writable<SharedSceneData>([]);

	// Reactive variable to hold selected satellite info
	const selectedSatellite = writable<{
		name: string;
		details: object | string;
		noradCatId?: number;
		latitude?: number;
		longitude?: number;
		index?: number;
		satrec?: SatRec;
	} | null>(null);
	const inputValue = writable('');
	let isMobileView = false;
	function hideLoadingScreen() {
		const loadingScreen = document.getElementById('loading-screen');
		if (loadingScreen) {
			loadingScreen.classList.add('fade-out');
			// Remove from DOM after transition completes
			setTimeout(() => {
				loadingScreen.remove();
			}, 600);
		}
	}

	async function loadSceneData(): Promise<SceneDataRow[]> {
		const response = await fetch(`${base}/data/scene-data.json`);
		if (!response.ok) {
			throw new Error(`Failed to load scene data: ${response.status}`);
		}
		const payload = (await response.json()) as unknown;
		if (!Array.isArray(payload)) {
			throw new Error('Invalid scene data response');
		}
		return payload as SceneDataRow[];
	}

	onMount(() => {
		const userAgent = window.navigator.userAgent;
		isMobileView = isMobile(userAgent);
		(async () => {
			try {
				const sceneData = await loadSceneData();
				const sceneController = await createScene(el, sceneData, selectedSatellite, sharedData);
				cleanup = sceneController.cleanup;
				focusPreviousVisibleSatellite = sceneController.focusPreviousVisibleSatellite;
				focusNextVisibleSatellite = sceneController.focusNextVisibleSatellite;
				getVisibleCount = sceneController.getVisibleCount;
				focusEarth = sceneController.focusEarth;
				focusVisibleNoradId = sceneController.focusVisibleNoradId;
			} catch (error) {
				console.error('Error initializing scene:', error);
			} finally {
				hideLoadingScreen();
			}
		})();
		latLongIntervalId = window.setInterval(() => {
			updateLatLong();
		}, 1000);
		chatWindow.addEventListener('mousemove', updateCursor);
		chatWindow.addEventListener('mousedown', initDrag);
	});

	onDestroy(() => {
		chatWindow.removeEventListener('mousemove', updateCursor);
		chatWindow.removeEventListener('mousedown', initDrag);
		if (latLongIntervalId !== undefined) {
			window.clearInterval(latLongIntervalId);
		}
		if (cleanup) cleanup();
	});

	function goLeft() {
		focusPreviousVisibleSatellite();
	}

	function goRight() {
		focusNextVisibleSatellite();
	}

	function formatCoordinate(value: number | undefined) {
		return typeof value === 'number' ? `${value.toFixed(2)}°` : '--';
	}

	function updateLatLong() {
		if ($selectedSatellite?.satrec) {
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

	async function assistChat(history: Message[]) {
		try {
			const response = await fetch(`${base}/api/assist`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					messages: history,
					sceneContext: {
						selectedNoradId: $selectedSatellite?.noradCatId ?? null,
						visibleCount: getVisibleCount(),
						selectedInfoPanel: $selectedSatellite
							? [
									`name=${$selectedSatellite.name}`,
									`details=${String($selectedSatellite.details ?? '')}`,
									`latitude=${formatCoordinate($selectedSatellite.latitude)}`,
									`longitude=${formatCoordinate($selectedSatellite.longitude)}`
								].join('; ')
							: 'none'
					}
				})
			});

			if (!response.ok) {
				throw new Error(`HTTP error! Status: ${response.status}`);
			}

			return (await response.json()) as AssistResponseBody;
		} catch (error) {
			console.error('Error calling assistChat: ', error);
		}
	}

	async function handleKeyUp(event: { key: string }) {
		if (event.key !== 'Enter') {
			return;
		}
		const userChatInput = $inputValue.trim();
		if (userChatInput.length === 0) {
			return;
		}

		chatHistory.update((history) => {
			return [...history, { role: 'user', content: userChatInput }];
		});
		$inputValue = '';
		await tick();
		messageContainer.scrollTop = messageContainer.scrollHeight;

		const result = await assistChat(get(chatHistory));
		if (!result) {
			chatHistory.update((history) => {
				return [...history, { role: 'assistant', content: 'Request failed. Please try again.' }];
			});
			await tick();
			messageContainer.scrollTop = messageContainer.scrollHeight;
			return;
		}

		if (result.action?.visibility) {
			const rows = result.action.visibility.noradCatIds.map((id) => ({ NORAD_CAT_ID: id }));
			sharedData.set([rows, result.action.visibility.mode]);
		}
		let assistantMessage = result.assistantMessage;
		if (result.action?.focus) {
			if (result.action.focus.target === 'earth') {
				focusEarth();
			} else {
				const targetNorad = result.action.focus.noradCatId;
				let focusApplied = focusVisibleNoradId(targetNorad);
				if (!focusApplied && !result.action?.visibility) {
					sharedData.set([[{ NORAD_CAT_ID: targetNorad }], 'add']);
					await tick();
					focusApplied = focusVisibleNoradId(targetNorad);
				}
				if (!focusApplied) {
					console.warn('Focus action could not be applied in current scene visibility.', {
						noradCatId: targetNorad
					});
					assistantMessage += `\n\n(Focus could not be applied for NORAD ${targetNorad} in the current scene.)`;
				}
			}
		}

		chatHistory.update((history) => {
			return [...history, { role: 'assistant', content: assistantMessage }];
		});
		await tick();
		messageContainer.scrollTop = messageContainer.scrollHeight;
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
		<pre>Latitude:   {formatCoordinate($selectedSatellite.latitude)}</pre>
		<pre>Longitude:  {formatCoordinate($selectedSatellite.longitude)}</pre>
		<div class="satellite-nav">
			<button class="nav-button" on:click={goLeft} aria-label="Go to previous visible object">
				&larr;
			</button>
			<button class="nav-button" on:click={goRight} aria-label="Go to next visible object">
				&rarr;
			</button>
		</div>
		<!-- <pre>{$selectedSatellite.details}</pre> -->
	{/if}
</div>

<!-- Floating input field -->
<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div
	bind:this={chatWindow}
	class="chat-window {isMobileView ? 'hidden' : ''} {isDragging ? 'no-select' : ''}"
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
	:global(html, body) {
		margin: 0;
		padding: 0;
		width: 100%;
		height: 100%;
		background: #000;
		overflow: hidden;
		overscroll-behavior: none;
	}

	textarea {
		resize: none;
	}

	.chat-window {
		border: 10px solid rgba(255, 255, 255, 0.1);
		box-sizing: border-box;
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
		padding: 10px 90px 10px 10px;
		border-radius: 5px;
		border: 1px solid white;
	}

	.satellite-nav {
		position: absolute;
		right: 10px;
		bottom: 10px;
		display: flex;
		gap: 6px;
	}

	.nav-button {
		width: 30px;
		height: 30px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 5px;
		border: 1px solid #ccc;
		color: white;
		background: rgba(0, 0, 0, 0.9);
		outline: none;
		font-size: 20px;
		line-height: 1;
		cursor: pointer;
	}

	.nav-button:hover {
		background-color: #232121;
		border-color: #aaa;
	}

	.visible {
		display: block;
	}

	.hidden {
		display: none;
	}

	.no-select {
		user-select: none;
		-webkit-user-select: none;
		-moz-user-select: none;
		-ms-user-select: none;
	}

	.resize-ns {
		cursor: ns-resize;
	}

	.resize-ew {
		cursor: ew-resize;
	}

	.resize-nwse {
		cursor: nwse-resize;
	}

	.resize-nesw {
		cursor: nesw-resize;
	}
</style>
