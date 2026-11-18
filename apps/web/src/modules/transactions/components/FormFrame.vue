<script setup lang="ts">
/**
 * QuickBooks-style form frame: title bar with the main actions, then the
 * header block, the line grid and the footer (memo + totals).
 */
import Button from 'primevue/button';
import Tag from 'primevue/tag';

defineProps<{
  title: string;
  subtitle?: string;
  mode: 'add' | 'mod';
  busy?: boolean;
  /** Disable saving (e.g. unbalanced journal entry). */
  blocked?: boolean;
  readOnly?: boolean;
  canSaveNew?: boolean;
}>();
const emit = defineEmits<{ save: []; saveNew: []; revert: []; close: [] }>();
</script>

<template>
  <section class="frame" :aria-label="title">
    <header class="frame__bar">
      <div class="frame__title">
        <h1>{{ title }}</h1>
        <Tag v-if="mode === 'mod'" severity="secondary" value="Editing" />
        <span v-if="subtitle" class="frame__sub">{{ subtitle }}</span>
      </div>
      <div class="frame__actions">
        <Button
          v-if="canSaveNew !== false && mode === 'add'"
          label="Save & New"
          icon="pi pi-plus"
          size="small"
          severity="secondary"
          :disabled="busy || blocked || readOnly"
          title="Alt+N"
          @click="emit('saveNew')"
        />
        <Button
          label="Save"
          icon="pi pi-check"
          size="small"
          :loading="busy"
          :disabled="blocked || readOnly"
          title="Ctrl+S"
          @click="emit('save')"
        />
        <Button
          label="Revert"
          icon="pi pi-undo"
          size="small"
          severity="secondary"
          text
          @click="emit('revert')"
        />
        <Button
          label="Close"
          icon="pi pi-times"
          size="small"
          severity="secondary"
          text
          @click="emit('close')"
        />
      </div>
    </header>
    <div class="frame__status"><slot name="status" /></div>
    <div class="frame__header"><slot name="header" /></div>
    <div class="frame__lines"><slot name="lines" /></div>
    <footer class="frame__footer">
      <div class="frame__footer-left"><slot name="footer" /></div>
      <div class="frame__footer-right"><slot name="totals" /></div>
    </footer>
    <p class="frame__keys">
      <kbd>Ctrl</kbd>+<kbd>S</kbd> save · <kbd>Alt</kbd>+<kbd>N</kbd> save &amp; new ·
      <kbd>Enter</kbd> next line · <kbd>Ctrl</kbd>+<kbd>Ins</kbd> insert line · <kbd>Ctrl</kbd>+<kbd
        >Del</kbd
      >
      delete line
    </p>
  </section>
</template>

<style scoped>
.frame {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-width: 82rem;
}
.frame__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  padding-bottom: 0.5rem;
  border-bottom: 2px solid var(--p-primary-color);
}
.frame__title {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.frame__title h1 {
  margin: 0;
  font-size: 1.4rem;
  font-weight: 600;
}
.frame__sub {
  color: var(--p-text-muted-color);
}
.frame__actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.frame__footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1.5rem;
  align-items: start;
}
.frame__keys {
  margin: 0;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.frame__keys kbd {
  font-family: inherit;
  border: 1px solid var(--p-content-border-color);
  border-radius: 3px;
  padding: 0 0.25rem;
  background: var(--p-content-background);
}
@media (max-width: 768px) {
  .frame__footer {
    grid-template-columns: 1fr;
  }
}
</style>
