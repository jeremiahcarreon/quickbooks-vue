<script setup lang="ts">
/** Highlighted, indented qbXML (read-only). */
import { computed } from 'vue';
import { highlightXml, prettyXml } from '@/lib/xml';

const props = withDefaults(defineProps<{ xml: string | null | undefined; pretty?: boolean }>(), {
  pretty: true,
});
const html = computed(() =>
  highlightXml(props.pretty ? prettyXml(props.xml ?? '') : (props.xml ?? '')),
);
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- output of highlightXml is HTML-escaped -->
  <pre class="xml-view xml-code" v-html="html" />
</template>
