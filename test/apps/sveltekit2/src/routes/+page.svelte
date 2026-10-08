<script>
  import { chunk } from 'lodash-es'; // client: tree-shaken, only chunk and what it needs
  let { data } = $props();
</script>
<p>{JSON.stringify(chunk([1, 2, 3, 4], 2))} {data.took}</p>
