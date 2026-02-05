<script lang="ts">
	import OraclePage from './oracle/+page.svelte';
	export let data: unknown;
</script>

<OraclePage data={data as import('./oracle/$types').PageData} />
