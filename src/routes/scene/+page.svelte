<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { createScene } from '$lib/scene';

    let el:HTMLCanvasElement;
    let cleanup: () => void;
	
	onMount(() => {
		cleanup = createScene(el);
    });

	onDestroy(() => {
		if (cleanup) cleanup();
	});
</script>

<svelte:head>
	<title>Three.js Sveltekit</title>
	<meta name="description" content="Three.js example app built with Svelte" />
</svelte:head>

<canvas bind:this={el} />