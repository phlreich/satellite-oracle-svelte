<!-- src/routes/oracle/+page.svelte -->
<script lang="ts">
	import type { PageData } from './$types';
	import { onMount, onDestroy } from 'svelte';
	import { createScene } from '$lib/scene';

	export let data: PageData;
    let el:HTMLCanvasElement;
    let cleanup: () => void;
	
	onMount(() => {
		cleanup = createScene(el, data.sceneData);
    });

	onDestroy(() => {
		if (cleanup) cleanup();
	});
</script>

<svelte:head>
	<title>Satellite Oracle</title>
	<meta name="description" content="The satellite oracle will see you now." />
</svelte:head>

<canvas bind:this={el} />