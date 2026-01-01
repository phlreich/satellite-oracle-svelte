<!-- src/routes/mobile-not-supported/+page.svelte -->
<script>
    import { onMount } from 'svelte';
    onMount(() => {
        document.getElementById('loading-screen')?.remove();
    });
</script>

<text>
    Mobile is not supported yet. Please use a desktop browser.
</text>
