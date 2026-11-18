<script setup lang="ts">
/**
 * Spotlight search: Ctrl+K (Cmd+K on macOS) opens a large overlay that
 * searches menu items and every record type the user can read. Results are
 * grouped by type; type chips (with match counts) narrow the search, and the
 * filter bar adds a date range, a customer/vendor, an amount range and
 * inactive records.
 */
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import InputText from 'primevue/inputtext';
import ProgressSpinner from 'primevue/progressspinner';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { searchApi, type SearchGroup, type SearchHit } from '@/api/endpoints';
import type { RefValue } from '@/components/types';
import DateInput from '@/components/DateInput.vue';
import RefPicker from '@/components/RefPicker.vue';
import { PARTY_ENTITIES } from '@/lib/entities';
import { entityTitle } from '@/lib/labels';
import { entityDetailRoute } from '@/lib/links';
import {
  activeFilterCount,
  canSearch,
  datePresets,
  emptyFilters,
  hitText,
  isSpotlightShortcut,
  matchMenu,
  type HitText,
} from '@/lib/spotlight';
import { modules, navGroups } from '@/modules/registry';
import type { NavItem } from '@/modules/types';
import { useAuthStore } from '@/stores/auth';
import { useMetaStore } from '@/stores/meta';

const router = useRouter();
const auth = useAuthStore();
const meta = useMetaStore();

const open = ref(false);
const text = ref('');
const selected = ref<string[]>([]);
const filters = reactive(emptyFilters());
const party = ref<RefValue | null>(null);
const showFilters = ref(false);
const groups = ref<SearchGroup[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const active = ref(0);
const input = ref<{ $el: HTMLInputElement } | null>(null);
const list = ref<HTMLElement | null>(null);
let lastFocus: HTMLElement | null = null;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const shortcutLabel = isMac ? '⌘K' : 'Ctrl K';

const menuItems = computed<NavItem[]>(() =>
  navGroups(modules, (p) => auth.can(p)).flatMap((g) => g.items),
);
const partyTypes = computed(() =>
  PARTY_ENTITIES.filter(
    (t) => auth.canRead(t) && (meta.entityNames.length ? meta.entityNames.includes(t) : true),
  ),
);
const presets = datePresets(new Date());
const filterCount = computed(() => activeFilterCount(filters));
const searchable = computed(() => canSearch(text.value, filters));

/** Menu matches are shown only when no record type is selected. */
const menuHits = computed(() =>
  selected.value.length ? [] : matchMenu(menuItems.value, text.value),
);

/** Facet chips: every type that matched, by label. */
const facets = computed(() =>
  [...groups.value]
    .map((g) => ({ type: g.type, total: g.total, label: entityTitle(g.type) }))
    .sort((a, b) => a.label.localeCompare(b.label)),
);
const totalMatches = computed(() => groups.value.reduce((n, g) => n + g.total, 0));
/** Names (customers, vendors, items...) before transactions; server order within each. */
const CATEGORY_ORDER: Record<string, number> = { list: 0, txn: 1, other: 2 };
const visibleGroups = computed(() =>
  groups.value
    .filter((g) => g.items.length > 0)
    .map((g, i) => ({ g, i }))
    .sort(
      (a, b) =>
        (CATEGORY_ORDER[a.g.category] ?? 2) - (CATEGORY_ORDER[b.g.category] ?? 2) || a.i - b.i,
    )
    .map(({ g }) => g),
);

type Row =
  | { kind: 'menu'; key: string; item: NavItem }
  | { kind: 'hit'; key: string; hit: SearchHit; text: HitText; category: string };

/** Everything selectable, in display order, for keyboard navigation. */
const rows = computed<Row[]>(() => [
  ...menuHits.value.map((item) => ({ kind: 'menu' as const, key: `m:${item.to}`, item })),
  ...visibleGroups.value.flatMap((g) =>
    g.items.map((hit) => ({
      kind: 'hit' as const,
      key: `h:${hit.type}:${hit.qbId}`,
      hit,
      text: hitText(hit, g.category),
      category: g.category,
    })),
  ),
]);
const indexOf = (key: string) => rows.value.findIndex((r) => r.key === key);

// ---------------------------------------------------------------------------
// Opening and closing

async function show() {
  if (open.value) {
    input.value?.$el.select();
    return;
  }
  lastFocus = document.activeElement as HTMLElement | null;
  open.value = true;
  await nextTick();
  input.value?.$el.focus();
  input.value?.$el.select();
}

function close() {
  open.value = false;
  lastFocus?.focus?.();
}

function onGlobalKey(e: KeyboardEvent) {
  if (!auth.isAuthenticated) return;
  if (isSpotlightShortcut(e)) {
    e.preventDefault();
    void show();
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKey));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKey);
  controller?.abort();
  if (timer) clearTimeout(timer);
});

watch(open, (v) => {
  document.body.style.overflow = v ? 'hidden' : '';
});

// ---------------------------------------------------------------------------
// Searching

let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;

async function run() {
  controller?.abort();
  if (!searchable.value) {
    groups.value = [];
    loading.value = false;
    error.value = null;
    return;
  }
  const my = (controller = new AbortController());
  loading.value = true;
  error.value = null;
  try {
    groups.value = await searchApi.search(
      {
        q: text.value.trim() || undefined,
        types: selected.value,
        from: filters.from ?? undefined,
        to: filters.to ?? undefined,
        entity: filters.entityId ?? undefined,
        amountMin: filters.amountMin ?? undefined,
        amountMax: filters.amountMax ?? undefined,
        includeInactive: filters.includeInactive,
        perType: selected.value.length === 1 ? 50 : selected.value.length ? 15 : 5,
      },
      my.signal,
    );
  } catch (err) {
    if (my.signal.aborted) return;
    error.value = (err as Error).message || 'Search failed';
    groups.value = [];
  } finally {
    if (controller === my) loading.value = false;
  }
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void run(), 200);
}

watch([text, selected, () => ({ ...filters })], schedule, { deep: true });
watch(rows, () => {
  active.value = 0;
});
watch(party, (v) => {
  filters.entityId = v?.ListID ?? null;
});

function toggleType(type: string) {
  selected.value = selected.value.includes(type)
    ? selected.value.filter((t) => t !== type)
    : [...selected.value, type];
}
function clearFilters() {
  Object.assign(filters, emptyFilters());
  party.value = null;
}
function applyPreset(e: Event) {
  const p = presets.find((x) => x.label === (e.target as HTMLSelectElement).value);
  if (p) Object.assign(filters, p.range);
  (e.target as HTMLSelectElement).value = '';
}

// ---------------------------------------------------------------------------
// Choosing a result

function choose(row: Row | undefined) {
  if (!row) return;
  close();
  void router.push(
    row.kind === 'menu' ? row.item.to : entityDetailRoute(row.hit.type, row.hit.qbId),
  );
}

async function move(delta: number) {
  const n = rows.value.length;
  if (!n) return;
  active.value = (active.value + delta + n) % n;
  await nextTick();
  list.value?.querySelector(`[data-row="${active.value}"]`)?.scrollIntoView({ block: 'nearest' });
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    void move(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    void move(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose(rows.value[active.value]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    close();
  }
}

defineExpose({ show, close });
</script>

<template>
  <button type="button" class="spot-trigger" aria-label="Search (Ctrl+K)" @click="show">
    <i class="pi pi-search" aria-hidden="true" />
    <span>Search records and menus…</span>
    <kbd>{{ shortcutLabel }}</kbd>
  </button>

  <Teleport to="body">
    <div v-if="open" class="spot" role="presentation" @mousedown.self="close" @keydown="onKey">
      <section class="spot__panel" role="dialog" aria-modal="true" aria-label="Search">
        <header class="spot__head">
          <i class="pi pi-search spot__icon" aria-hidden="true" />
          <InputText
            ref="input"
            v-model="text"
            class="spot__input"
            placeholder="Search customers, invoices, items, menus…"
            aria-label="Search text"
            aria-controls="spot-results"
            autocomplete="off"
            spellcheck="false"
          />
          <ProgressSpinner
            v-if="loading"
            class="spot__spinner"
            stroke-width="6"
            aria-label="Searching"
          />
          <Button
            :label="filterCount ? `Filters (${filterCount})` : 'Filters'"
            icon="pi pi-filter"
            :severity="filterCount ? 'primary' : 'secondary'"
            :outlined="!showFilters"
            size="small"
            :aria-expanded="showFilters"
            @click="showFilters = !showFilters"
          />
          <Button icon="pi pi-times" text rounded aria-label="Close search" @click="close" />
        </header>

        <div v-if="showFilters" class="spot__filters">
          <div class="spot__field spot__field--dates">
            <label>Date</label>
            <select class="spot__preset" aria-label="Date preset" @change="applyPreset">
              <option value="">Preset…</option>
              <option v-for="p in presets" :key="p.label" :value="p.label">{{ p.label }}</option>
            </select>
            <DateInput v-model="filters.from" placeholder="From" />
            <DateInput v-model="filters.to" placeholder="To" />
          </div>
          <div class="spot__field">
            <label>Customer / vendor</label>
            <RefPicker
              v-model="party"
              :entity="partyTypes"
              :allow-free-text="false"
              placeholder="Any"
            />
          </div>
          <div class="spot__field spot__field--amount">
            <label>Amount</label>
            <InputText
              v-model="filters.amountMin"
              inputmode="decimal"
              placeholder="Min"
              aria-label="Minimum amount"
            />
            <InputText
              v-model="filters.amountMax"
              inputmode="decimal"
              placeholder="Max"
              aria-label="Maximum amount"
            />
          </div>
          <label class="spot__check">
            <Checkbox v-model="filters.includeInactive" binary />
            Include inactive
          </label>
          <Button label="Clear" text size="small" :disabled="!filterCount" @click="clearFilters" />
          <small class="spot__hint">Date and amount filters apply to transactions.</small>
        </div>

        <nav v-if="facets.length" class="spot__facets" aria-label="Record types">
          <button
            type="button"
            class="spot__chip"
            :class="{ 'spot__chip--on': selected.length === 0 }"
            @click="selected = []"
          >
            All <span>{{ totalMatches }}</span>
          </button>
          <button
            v-for="f in facets"
            :key="f.type"
            type="button"
            class="spot__chip"
            :class="{ 'spot__chip--on': selected.includes(f.type) }"
            :aria-pressed="selected.includes(f.type)"
            @click="toggleType(f.type)"
          >
            {{ f.label }} <span>{{ f.total }}</span>
          </button>
        </nav>

        <div id="spot-results" ref="list" class="spot__results" role="listbox" aria-label="Results">
          <template v-if="menuHits.length">
            <h3 class="spot__group">Menus</h3>
            <div
              v-for="item in menuHits"
              :key="item.to"
              class="spot__row"
              :class="{ 'spot__row--active': rows[active]?.key === `m:${item.to}` }"
              :data-row="indexOf(`m:${item.to}`)"
              role="option"
              :aria-selected="rows[active]?.key === `m:${item.to}`"
              @mousemove="active = indexOf(`m:${item.to}`)"
              @click="choose(rows[indexOf(`m:${item.to}`)])"
            >
              <i :class="item.icon ?? 'pi pi-compass'" class="spot__row-icon" aria-hidden="true" />
              <div class="spot__row-text">
                <strong>{{ item.label }}</strong>
                <small>{{ item.area }}</small>
              </div>
              <span class="spot__pill">Menu</span>
            </div>
          </template>

          <template v-for="g in visibleGroups" :key="g.type">
            <h3 class="spot__group">
              {{ entityTitle(g.type) }}
              <span class="spot__count">{{ g.total }}</span>
              <button
                v-if="
                  g.total > g.items.length && !(selected.length === 1 && selected[0] === g.type)
                "
                type="button"
                class="spot__more"
                @click="selected = [g.type]"
              >
                Show all {{ g.total }}
              </button>
            </h3>
            <div
              v-for="row in rows.filter((r) => r.kind === 'hit' && r.hit.type === g.type)"
              :key="row.key"
              class="spot__row"
              :class="{ 'spot__row--active': rows[active]?.key === row.key }"
              :data-row="indexOf(row.key)"
              role="option"
              :aria-selected="rows[active]?.key === row.key"
              @mousemove="active = indexOf(row.key)"
              @click="choose(row)"
            >
              <template v-if="row.kind === 'hit'">
                <i
                  :class="row.category === 'txn' ? 'pi pi-file' : 'pi pi-id-card'"
                  class="spot__row-icon"
                  aria-hidden="true"
                />
                <div class="spot__row-text">
                  <strong>{{ row.text.title }}</strong>
                  <small v-if="row.text.subtitle">{{ row.text.subtitle }}</small>
                </div>
                <span v-if="row.text.amount" class="spot__amount">{{ row.text.amount }}</span>
              </template>
            </div>
          </template>

          <p v-if="error" class="spot__empty spot__empty--error">{{ error }}</p>
          <p v-else-if="!searchable && !menuHits.length" class="spot__empty">
            Type at least two characters, or set a filter, to search every record.
          </p>
          <p v-else-if="searchable && !loading && !rows.length" class="spot__empty">No matches.</p>
        </div>

        <footer class="spot__foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.spot-trigger {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: min(28rem, 100%);
  padding: 0.45rem 0.75rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-border-radius-md, 6px);
  background: var(--p-content-background);
  color: var(--p-text-muted-color);
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.spot-trigger:hover {
  border-color: var(--p-primary-color);
}
.spot-trigger span {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
kbd {
  font:
    0.75rem/1 ui-monospace,
    monospace;
  padding: 0.2rem 0.35rem;
  border: 1px solid var(--p-content-border-color);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--p-content-hover-background, transparent);
  color: var(--p-text-muted-color);
}

.spot {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 5vh 1rem;
  background: rgb(0 0 0 / 0.45);
  backdrop-filter: blur(2px);
}
.spot__panel {
  display: flex;
  flex-direction: column;
  width: min(72rem, 100%);
  height: min(86vh, 60rem);
  border-radius: 12px;
  background: var(--p-content-background);
  color: var(--p-text-color);
  box-shadow: 0 24px 64px rgb(0 0 0 / 0.35);
  overflow: hidden;
}
.spot__head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--p-content-border-color);
}
.spot__icon {
  font-size: 1.25rem;
  color: var(--p-text-muted-color);
}
.spot__input {
  flex: 1;
  border: 0;
  box-shadow: none;
  font-size: 1.25rem;
  padding: 0.5rem 0;
  background: transparent;
}
.spot__input:focus {
  outline: none;
  box-shadow: none;
}
.spot__spinner {
  width: 1.5rem;
  height: 1.5rem;
  margin: 0;
}
.spot__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem 1.25rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--p-content-border-color);
  background: var(--p-content-hover-background, transparent);
}
.spot__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 14rem;
}
.spot__field label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--p-text-muted-color);
}
.spot__field--dates,
.spot__field--amount {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.spot__field--dates label,
.spot__field--amount label {
  width: 100%;
}
.spot__field--dates > :not(label) {
  flex: none;
  width: 11rem;
}
.spot__field--dates > .spot__preset {
  width: auto;
}
.spot__field--amount :deep(input) {
  width: 7rem;
}
.spot__preset {
  padding: 0.45rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
  background: var(--p-content-background);
  color: inherit;
  font: inherit;
}
.spot__check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-bottom: 0.4rem;
}
.spot__hint {
  width: 100%;
  color: var(--p-text-muted-color);
}
.spot__facets {
  display: flex;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  overflow-x: auto;
  border-bottom: 1px solid var(--p-content-border-color);
}
.spot__chip {
  flex: none;
  padding: 0.3rem 0.75rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
}
.spot__chip span {
  margin-left: 0.25rem;
  color: var(--p-text-muted-color);
}
.spot__chip--on {
  border-color: var(--p-primary-color);
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
}
.spot__chip--on span {
  color: inherit;
  opacity: 0.85;
}
.spot__results {
  flex: 1;
  overflow-y: auto;
  padding: 0.25rem 0.5rem 0.75rem;
}
.spot__group {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0.75rem 0.5rem 0.35rem;
  background: var(--p-content-background);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}
.spot__count {
  font-weight: 400;
}
.spot__more {
  margin-left: auto;
  border: 0;
  background: none;
  color: var(--p-primary-color);
  font: inherit;
  text-transform: none;
  letter-spacing: 0;
  cursor: pointer;
}
.spot__row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.55rem 0.75rem;
  border-radius: 8px;
  cursor: pointer;
}
.spot__row--active {
  background: var(--p-highlight-background);
  color: var(--p-highlight-color);
}
.spot__row-icon {
  color: var(--p-text-muted-color);
}
.spot__row-text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
}
.spot__row-text strong,
.spot__row-text small {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.spot__row-text small {
  color: var(--p-text-muted-color);
}
.spot__amount {
  font-variant-numeric: tabular-nums;
}
.spot__pill {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.spot__empty {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--p-text-muted-color);
}
.spot__empty--error {
  color: var(--p-red-500, #dc2626);
}
.spot__foot {
  display: flex;
  gap: 1.25rem;
  padding: 0.5rem 1rem;
  border-top: 1px solid var(--p-content-border-color);
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}
.spot__foot kbd {
  margin-right: 0.2rem;
}

@media (max-width: 640px) {
  .spot {
    padding: 0;
  }
  .spot__panel {
    height: 100%;
    border-radius: 0;
  }
  .spot-trigger span {
    display: none;
  }
  .spot__foot {
    display: none;
  }
}
</style>
