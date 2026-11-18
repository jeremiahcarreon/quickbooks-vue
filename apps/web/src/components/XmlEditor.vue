<script setup lang="ts">
/**
 * qbXML editor: a textarea over a highlighted copy of the same text, with
 * line numbers and error markers (lines from libxml2 / the well-formedness
 * check).
 */
import { computed, ref } from 'vue';
import { highlightXml } from '@/lib/xml';

const props = withDefaults(
  defineProps<{ modelValue: string; errorLines?: number[]; disabled?: boolean; rows?: number }>(),
  { errorLines: () => [], disabled: false, rows: 24 },
);
const emit = defineEmits<{ 'update:modelValue': [v: string]; submit: [] }>();

const ta = ref<HTMLTextAreaElement | null>(null);
const pre = ref<HTMLElement | null>(null);
const gutter = ref<HTMLElement | null>(null);

// trailing newline keeps the overlay height in step with the textarea
const html = computed(() => `${highlightXml(props.modelValue)}\n`);
const lines = computed(() => props.modelValue.split('\n').length);
const errSet = computed(() => new Set(props.errorLines));

function sync() {
  if (!ta.value) return;
  if (pre.value) {
    pre.value.scrollTop = ta.value.scrollTop;
    pre.value.scrollLeft = ta.value.scrollLeft;
  }
  if (gutter.value) gutter.value.scrollTop = ta.value.scrollTop;
}
function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    emit('submit');
    return;
  }
  if (e.key === 'Tab' && ta.value) {
    e.preventDefault();
    const el = ta.value;
    const s = el.selectionStart;
    const v = props.modelValue;
    emit('update:modelValue', `${v.slice(0, s)}  ${v.slice(el.selectionEnd)}`);
    requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
  }
}
</script>

<template>
  <div class="xml-editor" :style="{ '--rows': rows }">
    <div ref="gutter" class="xml-editor__gutter" aria-hidden="true">
      <div v-for="n in lines" :key="n" :class="{ 'xml-editor__err': errSet.has(n) }">{{ n }}</div>
    </div>
    <div class="xml-editor__body">
      <!-- eslint-disable-next-line vue/no-v-html -- output of highlightXml is HTML-escaped -->
      <pre ref="pre" class="xml-editor__hl xml-code" aria-hidden="true" v-html="html" />
      <textarea
        ref="ta"
        class="xml-editor__input"
        :value="modelValue"
        :disabled="disabled"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        aria-label="qbXML request"
        wrap="off"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @scroll="sync"
        @keydown="onKey"
      />
    </div>
  </div>
</template>

<style scoped>
.xml-editor {
  display: flex;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
  height: calc(var(--rows) * 1.4em + 1rem);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.4em;
  overflow: hidden;
}
.xml-editor__gutter {
  padding: 0.5rem 0.4rem;
  text-align: right;
  color: var(--p-text-muted-color);
  background: var(--p-content-hover-background);
  user-select: none;
  overflow: hidden;
  min-width: 2.5rem;
}
.xml-editor__err {
  color: var(--p-red-500);
  font-weight: 700;
}
.xml-editor__body {
  position: relative;
  flex: 1;
  overflow: hidden;
}
.xml-editor__hl,
.xml-editor__input {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: 0.5rem;
  font: inherit;
  line-height: inherit;
  white-space: pre;
  overflow: auto;
  tab-size: 2;
  border: 0;
}
.xml-editor__hl {
  pointer-events: none;
  overflow: hidden;
}
.xml-editor__input {
  resize: none;
  background: transparent;
  color: transparent;
  caret-color: var(--p-text-color);
  outline: none;
}
.xml-editor__input::selection {
  background: color-mix(in srgb, var(--p-primary-color) 30%, transparent);
  color: transparent;
}
</style>
