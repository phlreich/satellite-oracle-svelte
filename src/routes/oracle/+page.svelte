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
	let applyOrbitOverlay = (_noradCatIds: number[], _mode: SharedSceneIntent) => {};

	type Message = {
		role: 'user' | 'assistant';
		content: string;
		kind?: 'chat' | 'tool';
	};
	type SharedSceneIntent = 'replace' | 'add' | 'remove';
	type SharedSceneData = [Array<{ NORAD_CAT_ID: number }>, SharedSceneIntent] | [];
	type SceneDataRow = [string, string, string, number, string];
	type AssistResponseBody = {
		assistantMessage: string;
		historyMessages?: Array<{
			role: 'assistant' | 'user';
			content: string;
		}>;
		action: {
			visibility?: {
				mode: 'replace' | 'add' | 'remove';
				noradCatIds: number[];
				returnedCount: number;
			};
			orbits?: {
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
	let assistPending = false;
	let thinkingPhrase = '';
	let thinkingPhraseQueue: string[] = [];
	let thinkingDisplay = '';
	let thinkingRevealTimeoutId: number | undefined;
	let thinkingTypeIntervalId: number | undefined;
	type ThinkingPhase = 'idle' | 'cursor' | 'typing' | 'holding' | 'erasing';
	let thinkingPhase: ThinkingPhase = 'idle';
	let thinkingStopRequested = false;
	let thinkingStopResolver: (() => void) | undefined;
	const thinkingPhrases = [
		'QUERYING CATALOG',
		'SCANNING TELEMETRY',
		'PARSING EPHEMERIS',
		'CORRELATING TRACKS',
		'INTERROGATING DATABASE',
		'PROPAGATING ORBITS',
		'CONSULTING THE ORACLE',
		'CROSS-REFERENCING OBJECTS',
		'RESOLVING ELEMENTS',
		'ACQUIRING SIGNAL',
		'AWAITING DOWNLINK',
		'REDUCING OBSERVATIONS',
		'REMEMBERING',
		'STILL LOOKING',
		'SECOND PASS',
		'VALIDATING EPOCHS',
		'REBUILDING CONTEXT',
		'INDEXING DISTANCE',
		'CENSORING MANIFOLD'
	];
	const atmosphericPhrases: ReadonlySet<string> = new Set([
		'AWAITING DOWNLINK',
		'ACQUIRING SIGNAL',
		'STILL LOOKING',
		'REMEMBERING',
		'SECOND PASS'
	]);
	const THINKING_CURSOR_ONLY_BLINKS = 2;
	const THINKING_BETWEEN_PHRASES_BLINKS = 1;
	const THINKING_TYPE_INTERVAL_MS = 70;
	const THINKING_HOLD_FULL_MS = 6000;
	const THINKING_ERASE_INTERVAL_MS = 45;
	const FALLBACK_CURSOR_BLINK_MS = 800;
	let isMobileView = false;

	function getCursorBlinkDurationMs() {
		const rawValue = getComputedStyle(document.documentElement)
			.getPropertyValue('--cursor-blink-duration')
			.trim();
		if (!rawValue) {
			return FALLBACK_CURSOR_BLINK_MS;
		}
		if (rawValue.endsWith('ms')) {
			const parsed = Number(rawValue.slice(0, -2));
			return Number.isFinite(parsed) ? parsed : FALLBACK_CURSOR_BLINK_MS;
		}
		if (rawValue.endsWith('s')) {
			const parsed = Number(rawValue.slice(0, -1)) * 1000;
			return Number.isFinite(parsed) ? parsed : FALLBACK_CURSOR_BLINK_MS;
		}
		const parsed = Number(rawValue);
		return Number.isFinite(parsed) ? parsed : FALLBACK_CURSOR_BLINK_MS;
	}

	function stopThinkingAnimation() {
		if (thinkingRevealTimeoutId !== undefined) {
			window.clearTimeout(thinkingRevealTimeoutId);
			thinkingRevealTimeoutId = undefined;
		}
		if (thinkingTypeIntervalId !== undefined) {
			window.clearInterval(thinkingTypeIntervalId);
			thinkingTypeIntervalId = undefined;
		}
		thinkingDisplay = '';
		thinkingPhase = 'idle';
		thinkingStopRequested = false;
		if (thinkingStopResolver) {
			thinkingStopResolver();
			thinkingStopResolver = undefined;
		}
	}

	function stopThinkingAnimationGracefully() {
		thinkingStopRequested = true;
		if (thinkingPhase === 'typing' || thinkingPhase === 'erasing') {
			return new Promise<void>((resolve) => {
				if (thinkingStopResolver) {
					const previousResolver = thinkingStopResolver;
					thinkingStopResolver = () => {
						previousResolver();
						resolve();
					};
					return;
				}
				thinkingStopResolver = resolve;
			});
		}
		stopThinkingAnimation();
		return Promise.resolve();
	}

	function shufflePhrases(avoid?: string): string[] {
		const pool = thinkingPhrases.slice();
		for (let i = pool.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[pool[i], pool[j]] = [pool[j], pool[i]];
		}
		// Spread atmospheric phrases so none are adjacent.
		for (let i = 0; i < pool.length - 1; i++) {
			if (atmosphericPhrases.has(pool[i]) && atmosphericPhrases.has(pool[i + 1])) {
				// Find nearest non-atmospheric phrase after i+1 to swap with.
				for (let j = i + 2; j < pool.length; j++) {
					if (!atmosphericPhrases.has(pool[j])) {
						[pool[i + 1], pool[j]] = [pool[j], pool[i + 1]];
						break;
					}
				}
			}
		}
		if (avoid && pool.length > 1 && pool[0] === avoid) {
			const swapIndex = 1 + Math.floor(Math.random() * (pool.length - 1));
			[pool[0], pool[swapIndex]] = [pool[swapIndex], pool[0]];
		}
		return pool;
	}

	function nextThinkingPhrase() {
		if (thinkingPhraseQueue.length === 0) {
			thinkingPhraseQueue = shufflePhrases(thinkingPhrase);
		}
		return thinkingPhraseQueue.shift()!;
	}

	function queueThinkingCycle(cursorOnlyMs: number) {
		thinkingDisplay = '';
		thinkingPhrase = nextThinkingPhrase();
		thinkingPhase = 'cursor';
		thinkingRevealTimeoutId = window.setTimeout(() => {
			if (!assistPending) {
				stopThinkingAnimation();
				return;
			}
			if (thinkingStopRequested) {
				stopThinkingAnimation();
				return;
			}
			thinkingPhase = 'typing';
			let charIndex = 0;
			thinkingTypeIntervalId = window.setInterval(() => {
				charIndex += 1;
				thinkingDisplay = thinkingPhrase.slice(0, charIndex);
				if (charIndex < thinkingPhrase.length) {
					return;
				}
				if (thinkingTypeIntervalId !== undefined) {
					window.clearInterval(thinkingTypeIntervalId);
					thinkingTypeIntervalId = undefined;
				}
				if (thinkingStopRequested) {
					stopThinkingAnimation();
					return;
				}
				thinkingPhase = 'holding';
				thinkingRevealTimeoutId = window.setTimeout(() => {
					if (!assistPending) {
						stopThinkingAnimation();
						return;
					}
					if (thinkingStopRequested) {
						stopThinkingAnimation();
						return;
					}
					let eraseIndex = thinkingPhrase.length;
					thinkingPhase = 'erasing';
					thinkingTypeIntervalId = window.setInterval(() => {
						eraseIndex -= 1;
						thinkingDisplay = thinkingPhrase.slice(0, Math.max(eraseIndex, 0));
						if (eraseIndex > 0) {
							return;
						}
						if (thinkingTypeIntervalId !== undefined) {
							window.clearInterval(thinkingTypeIntervalId);
							thinkingTypeIntervalId = undefined;
						}
						if (thinkingStopRequested) {
							stopThinkingAnimation();
							return;
						}
						const betweenPhrasesMs =
							getCursorBlinkDurationMs() * THINKING_BETWEEN_PHRASES_BLINKS;
						queueThinkingCycle(betweenPhrasesMs);
					}, THINKING_ERASE_INTERVAL_MS);
				}, THINKING_HOLD_FULL_MS);
			}, THINKING_TYPE_INTERVAL_MS);
		}, cursorOnlyMs);
	}

	function startThinkingAnimation() {
		stopThinkingAnimation();
		thinkingStopRequested = false;
		const cursorOnlyMs = getCursorBlinkDurationMs() * THINKING_CURSOR_ONLY_BLINKS;
		queueThinkingCycle(cursorOnlyMs);
	}

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
				applyOrbitOverlay = sceneController.applyOrbitOverlay;
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
		stopThinkingAnimation();
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

	function scrollChatToBottom() {
		if (!messageContainer) {
			return;
		}
		messageContainer.scrollTop = messageContainer.scrollHeight;
	}

	function scrollToLatestAssistantMessageStart() {
		if (!messageContainer) {
			return;
		}
		const assistantMessages = messageContainer.querySelectorAll<HTMLElement>('.message.assistant');
		const latestAssistantMessage = assistantMessages[assistantMessages.length - 1];
		if (!latestAssistantMessage) {
			scrollChatToBottom();
			return;
		}
		latestAssistantMessage.scrollIntoView({ block: 'start' });
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
					messages: history
						.filter((message) => message.kind !== 'tool')
						.map((message) => ({
							role: message.role,
							content: message.content
						})),
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
		if (event.key !== 'Enter' || assistPending) {
			return;
		}
		const userChatInput = $inputValue.trim();
		if (userChatInput.length === 0) {
			return;
		}

		chatHistory.update((history) => {
			return [...history, { role: 'user', content: userChatInput, kind: 'chat' }];
		});
		$inputValue = '';
		assistPending = true;
		startThinkingAnimation();
		await tick();
		scrollChatToBottom();

		const result = await assistChat(get(chatHistory));
		await stopThinkingAnimationGracefully();
		assistPending = false;
		if (!result) {
			chatHistory.update((history) => {
				return [
					...history,
					{ role: 'assistant', content: 'Request failed. Please try again.', kind: 'chat' }
				];
			});
			await tick();
			scrollToLatestAssistantMessageStart();
			return;
		}

		if (result.action?.visibility) {
			const rows = result.action.visibility.noradCatIds.map((id) => ({ NORAD_CAT_ID: id }));
			sharedData.set([rows, result.action.visibility.mode]);
		}
		if (result.action?.orbits) {
			applyOrbitOverlay(result.action.orbits.noradCatIds, result.action.orbits.mode);
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
			return [
				...history,
				{ role: 'assistant', content: assistantMessage, kind: 'chat' }
			];
		});
		await tick();
		scrollToLatestAssistantMessageStart();
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
			{#if message.content != null && message.kind !== 'tool'}
				<div class="message {message.role}">
					{message.content}
				</div>
			{/if}
		{/each}
		{#if assistPending}
			<div class="message assistant thinking">
				{thinkingDisplay}<span class="thinking-cursor"></span>
			</div>
		{/if}
	</div>
	<div class="input-area">
		<textarea
			class="input-field"
			bind:value={$inputValue}
			placeholder="Type anything..."
			on:keyup={handleKeyUp}
			disabled={assistPending}
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
		font-family: Consolas, 'Courier New', 'Liberation Mono', monospace;
	}

	textarea {
		resize: none;
		font-family: inherit;
	}

	.chat-window {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		position: absolute;
		bottom: 10px;
		right: 10px;
		color: white;
		background: rgba(0, 0, 0, 0.9);
		padding: 12px;
		max-height: 60vh;
		max-width: calc(100vw - 20px);
		overflow: hidden;
		width: 550px;
		height: 350px;
		border: 1px solid white;
		font-size: large;
	}

	.message-container {
		overflow-y: auto;
		flex-grow: 1;
		margin-bottom: 10px;
		/* Firefox */
		scrollbar-width: thin;
		scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
	}

	/* Chromium / Safari */
	.message-container::-webkit-scrollbar {
		width: 5px;
	}

	.message-container::-webkit-scrollbar-track {
		background: transparent;
	}

	.message-container::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.15);
		border-radius: 9999px;
		transition: background 0.2s;
	}

	.message-container::-webkit-scrollbar-thumb:hover {
		background: rgba(255, 255, 255, 0.4);
	}

	.message-container::-webkit-scrollbar-thumb:active {
		background: rgba(255, 255, 255, 0.55);
	}

	.message-container::-webkit-scrollbar-corner {
		background: transparent;
	}

	.input-field {
		color: white;
		background: rgba(0, 0, 0, 0.9);
		padding: 8px;
		margin-right: 8px;
		border: 1px solid rgba(255, 255, 255, 0.4);
		font-size: large;
		width: 100%;
		box-sizing: border-box;
		scrollbar-width: thin;
		scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
	}

	.input-field::-webkit-scrollbar {
		width: 5px;
	}

	.input-field::-webkit-scrollbar-track {
		background: transparent;
	}

	.input-field::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.15);
		border-radius: 9999px;
	}

	.input-field::-webkit-scrollbar-thumb:hover {
		background: rgba(255, 255, 255, 0.4);
	}

	.input-field::-webkit-scrollbar-thumb:active {
		background: rgba(255, 255, 255, 0.55);
	}

	.input-field::placeholder {
		color: rgba(255, 255, 255, 0.3);
	}

	.input-field:focus {
		border-color: white;
	}

	.input-field:disabled {
		opacity: 0.4;
		cursor: default;
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
		padding: 8px 10px;
		margin-bottom: 8px;
		word-wrap: break-word;
		border-left: 2px solid rgba(255, 255, 255, 0.2);
		background: rgba(255, 255, 255, 0.03);
		font-size: 0.92em;
		line-height: 1.5;
	}

	.message.user {
		text-align: right;
		border-left: none;
		border-right: 2px solid rgba(255, 255, 255, 0.5);
		background: rgba(255, 255, 255, 0.06);
	}

	.message.thinking {
		padding: 8px 10px;
		display: flex;
		align-items: center;
		gap: 0.2em;
		font-size: 0.78em;
		line-height: 1;
		letter-spacing: 0.12em;
		color: rgba(255, 255, 255, 0.5);
	}

	.thinking-cursor {
		display: inline-block;
		width: 0.45em;
		height: 1em;
		background: rgba(255, 255, 255, 0.5);
		animation: blink var(--cursor-blink-duration, 0.8s) step-end infinite;
	}

	@keyframes blink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0; }
	}

	.reset-button {
		padding: 5px 12px;
		border: 1px solid rgba(255, 255, 255, 0.4);
		color: rgba(255, 255, 255, 0.7);
		background: rgba(0, 0, 0, 0.9);
		outline: none;
		font-size: small;
		font-family: inherit;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		cursor: pointer;
		white-space: nowrap;
	}

	.reset-button:hover {
		background-color: #232121;
		border-color: white;
		color: white;
	}

	.satellite-info {
		position: absolute;
		min-width: 0;
		max-width: calc(100vw - 20px);
		width: 350px;
		bottom: 10px;
		left: 10px;
		color: white;
		background: rgba(0, 0, 0, 0.9);
		padding: 10px 90px 10px 10px;
		border: 1px solid white;
		box-sizing: border-box;
	}

	.satellite-info h2 {
		margin: 0 0 4px 0;
		font-size: large;
		font-weight: normal;
		letter-spacing: 0.05em;
	}

	.satellite-info pre {
		margin: 2px 0;
		font-family: inherit;
		font-size: 0.85em;
		color: rgba(255, 255, 255, 0.7);
	}

	.satellite-nav {
		position: absolute;
		right: 10px;
		bottom: 10px;
		display: flex;
		gap: 4px;
	}

	.nav-button {
		width: 28px;
		height: 28px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid rgba(255, 255, 255, 0.4);
		color: white;
		background: rgba(0, 0, 0, 0.9);
		outline: none;
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
		font-family: inherit;
	}

	.nav-button:hover {
		background-color: #232121;
		border-color: white;
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

	/* ── Responsive: medium viewports (≤900px) ── */
	@media (max-width: 900px) {
		.chat-window {
			width: calc(100vw - 20px);
			max-width: none;
			right: 10px;
			left: 10px;
			bottom: 10px;
			height: 250px;
			max-height: 40vh;
			font-size: medium;
		}

		.satellite-info {
			width: auto;
			max-width: calc(100vw - 20px);
			left: 10px;
			right: 10px;
			bottom: auto;
			top: 10px;
			padding: 8px 70px 8px 8px;
		}

		.satellite-info h2 {
			font-size: medium;
		}

		.satellite-info pre {
			font-size: 0.78em;
		}

		.input-field {
			font-size: medium;
		}

		.message {
			font-size: 0.85em;
			padding: 6px 8px;
		}
	}

	/* ── Responsive: small viewports (≤550px) ── */
	@media (max-width: 550px) {
		.chat-window {
			padding: 8px;
			height: 200px;
			max-height: 35vh;
			font-size: small;
		}

		.satellite-info {
			padding: 6px 60px 6px 6px;
		}

		.satellite-info h2 {
			font-size: small;
			letter-spacing: 0;
		}

		.satellite-info pre {
			font-size: 0.72em;
		}

		.input-field {
			font-size: small;
			padding: 6px;
		}

		.reset-button {
			padding: 4px 8px;
			font-size: x-small;
		}

		.message {
			font-size: 0.78em;
			padding: 5px 6px;
			margin-bottom: 6px;
		}

		.message.thinking {
			font-size: 0.68em;
		}

		.nav-button {
			width: 24px;
			height: 24px;
			font-size: 14px;
		}
	}
</style>
