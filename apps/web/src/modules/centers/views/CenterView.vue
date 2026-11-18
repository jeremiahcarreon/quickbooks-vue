<script setup lang="ts">
/**
 * Customer / Vendor Center: searchable list on the left; the selected
 * customer or vendor's details, balance, quick actions and transactions on
 * the right. Arrow keys move through the list.
 */
import Button from 'primevue/button';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { getObject, listObjects } from '../../transactions/lib/api';
import { dec, fmtMoney } from '../../transactions/lib/decimal';
import { displayName, refLabel } from '../../transactions/lib/refs';
import type { ObjectRow } from '../../transactions/lib/types';
import {
  actionPath,
  CENTERS,
  entityBalance,
  entityTransactions,
  typeLabel,
  type CenterKind,
  type TxnSummary,
} from '../lib/centers';

const props = defineProps<{ kind: CenterKind; id?: string }>();
const router = useRouter();
const config = computed(() => CENTERS[props.kind]);

const q = ref('');
const includeInactive = ref(false);
const rows = ref<ObjectRow[]>([]);
const total = ref(0);
const page = ref(1);
const listLoading = ref(false);
const listError = ref<string | null>(null);
const selected = ref<ObjectRow | null>(null);
const txns = ref<TxnSummary[]>([]);
const txnsLoading = ref(false);
const txnsFailed = ref<string[]>([]);
const typeFilter = ref('');
const listEl = ref<HTMLElement | null>(null);
const PAGE = 50;

async function loadList(reset = true) {
  listLoading.value = true;
  listError.value = null;
  if (reset) page.value = 1;
  try {
    const res = await listObjects(config.value.entityType, {
      q: q.value.trim() || undefined,
      sort: 'name',
      page: page.value,
      pageSize: PAGE,
      includeInactive: includeInactive.value,
    });
    rows.value = reset ? res.items : [...rows.value, ...res.items];
    total.value = res.total;
  } catch (err) {
    listError.value = err instanceof Error ? err.message : String(err);
  } finally {
    listLoading.value = false;
  }
}

let debounce: ReturnType<typeof setTimeout> | null = null;
watch([q, includeInactive], () => {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => void loadList(true), 250);
});

function more() {
  page.value += 1;
  void loadList(false);
}

async function loadSelected(id: string | undefined) {
  txns.value = [];
  txnsFailed.value = [];
  if (!id) {
    selected.value = null;
    return;
  }
  const inList = rows.value.find((r) => r.id === id);
  selected.value = inList ?? null;
  txnsLoading.value = true;
  try {
    if (!inList) selected.value = await getObject(config.value.entityType, id);
    const res = await entityTransactions(config.value, id);
    txns.value = res.items;
    txnsFailed.value = res.failed;
  } catch {
    txnsFailed.value = config.value.txnTypes;
  } finally {
    txnsLoading.value = false;
  }
}

watch(
  () => props.kind,
  () => {
    q.value = '';
    typeFilter.value = '';
    void loadList(true);
  },
  { immediate: true },
);
watch(
  () => [props.kind, props.id] as const,
  ([, id]) => void loadSelected(id),
  { immediate: true },
);

function base() {
  return props.kind === 'customer' ? '/centers/customers' : '/centers/vendors';
}

function select(row: ObjectRow) {
  void router.replace(`${base()}/${encodeURIComponent(row.id)}`);
}

async function onListKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const i = rows.value.findIndex((r) => r.id === props.id);
  const next =
    rows.value[Math.max(0, Math.min(rows.value.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
  if (next) {
    select(next);
    await nextTick();
    listEl.value
      ?.querySelector<HTMLElement>(`[data-id="${next.id.replace(/["\\]/g, '\\$&')}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }
}

const shownTxns = computed(() =>
  typeFilter.value ? txns.value.filter((t) => t.type === typeFilter.value) : txns.value,
);
const openTotal = computed(() =>
  txns.value
    .filter((t) => ['Invoice', 'Charge', 'Bill'].includes(t.type))
    .reduce((s, t) => s + dec(t.open), 0n),
);

const d = computed(() => selected.value?.data ?? {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const address = computed(() => {
  const a = (d.value.BillAddress ?? d.value.VendorAddress) as Record<string, unknown> | undefined;
  if (!a || typeof a !== 'object') return [];
  const city = [str(a.City), str(a.State), str(a.PostalCode)].filter(Boolean).join(' ');
  return [str(a.Addr1), str(a.Addr2), str(a.Addr3), str(a.Addr4), city].filter(Boolean);
});
const isActive = computed(() => d.value.IsActive !== 'false');
</script>

<template>
  <section class="center">
    <aside class="center__list" :aria-label="`${config.entityType} list`">
      <div class="center__search">
        <input
          v-model="q"
          type="search"
          class="in"
          :placeholder="`Search ${config.entityType.toLowerCase()}s`"
          :aria-label="`Search ${config.entityType.toLowerCase()}s`"
        />
        <label class="chk"
          ><input v-model="includeInactive" type="checkbox" /> Include inactive</label
        >
      </div>
      <Message v-if="listError" severity="error" :closable="false">{{ listError }}</Message>
      <ul
        ref="listEl"
        class="center__rows"
        tabindex="0"
        role="listbox"
        :aria-label="config.title"
        @keydown="onListKey"
      >
        <li
          v-for="r in rows"
          :key="r.id"
          role="option"
          :data-id="r.id"
          :aria-selected="r.id === id"
          :class="{ sel: r.id === id }"
          @click="select(r)"
        >
          <span class="nm">{{ displayName(r) }}</span>
          <span class="bal">{{ fmtMoney(dec(entityBalance(r))) }}</span>
        </li>
        <li v-if="listLoading" class="muted">Loading...</li>
        <li v-else-if="!rows.length" class="muted">Nothing found.</li>
      </ul>
      <Button
        v-if="rows.length < total"
        size="small"
        text
        :label="`Load more (${rows.length} of ${total})`"
        @click="more"
      />
    </aside>

    <div class="center__detail">
      <header class="center__head">
        <h1>{{ config.title }}</h1>
      </header>
      <p v-if="!selected && !id" class="muted">
        Choose a {{ config.entityType.toLowerCase() }} on the left.
      </p>
      <template v-if="selected">
        <div class="card">
          <div class="card__main">
            <h2>
              {{ displayName(selected) }}
              <Tag v-if="!isActive" severity="secondary" value="Inactive" />
            </h2>
            <dl class="facts">
              <template v-if="str(d.CompanyName)"
                ><dt>Company</dt>
                <dd>{{ str(d.CompanyName) }}</dd></template
              >
              <template v-if="str(d.Contact)"
                ><dt>Contact</dt>
                <dd>{{ str(d.Contact) }}</dd></template
              >
              <template v-if="str(d.Phone)"
                ><dt>Phone</dt>
                <dd>{{ str(d.Phone) }}</dd></template
              >
              <template v-if="str(d.Email)"
                ><dt>Email</dt>
                <dd>
                  <a :href="`mailto:${str(d.Email)}`">{{ str(d.Email) }}</a>
                </dd></template
              >
              <template v-if="address.length"
                ><dt>Address</dt>
                <dd>
                  <span v-for="l in address" :key="l" class="addr">{{ l }}</span>
                </dd></template
              >
              <template v-if="refLabel(d.TermsRef)"
                ><dt>Terms</dt>
                <dd>{{ refLabel(d.TermsRef) }}</dd></template
              >
              <template v-if="str(d.AccountNumber)"
                ><dt>Account no.</dt>
                <dd>{{ str(d.AccountNumber) }}</dd></template
              >
            </dl>
          </div>
          <div class="card__bal">
            <div class="big">{{ fmtMoney(dec(entityBalance(selected))) }}</div>
            <div class="muted">
              {{ kind === 'customer' ? 'Balance (incl. jobs)' : 'Balance owed' }}
            </div>
            <div v-if="openTotal > 0n" class="muted">
              Open {{ kind === 'customer' ? 'invoices' : 'bills' }} below: {{ fmtMoney(openTotal) }}
            </div>
          </div>
        </div>
        <nav class="actions" aria-label="Quick actions">
          <RouterLink
            v-for="a in config.actions"
            :key="a.label"
            :to="actionPath(a, selected.id)"
            class="action"
          >
            <i :class="a.icon" aria-hidden="true" /> {{ a.label }}
          </RouterLink>
        </nav>
        <div class="txn-head">
          <h3>Transactions</h3>
          <select v-model="typeFilter" class="in" aria-label="Filter by type">
            <option value="">All types</option>
            <option v-for="t in config.txnTypes" :key="t" :value="t">{{ typeLabel(t) }}</option>
          </select>
        </div>
        <Message v-if="txnsFailed.length" severity="warn" :closable="false">
          Could not load: {{ txnsFailed.map(typeLabel).join(', ') }}
        </Message>
        <div class="wrap">
          <table class="t" aria-label="Transactions">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Num</th>
                <th scope="col">Date</th>
                <th scope="col">Due</th>
                <th scope="col">Memo</th>
                <th scope="col" class="num">Amount</th>
                <th scope="col" class="num">Open</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="txnsLoading">
                <td colspan="7" class="muted">Loading...</td>
              </tr>
              <tr v-else-if="!shownTxns.length">
                <td colspan="7" class="muted">No transactions.</td>
              </tr>
              <tr
                v-for="t in shownTxns"
                :key="`${t.type}-${t.id}`"
                :class="{ link: !!t.path }"
                :tabindex="t.path ? 0 : undefined"
                @click="t.path && router.push(t.path)"
                @keydown.enter="t.path && router.push(t.path)"
              >
                <td>{{ typeLabel(t.type) }}</td>
                <td>{{ t.number }}</td>
                <td>{{ t.date }}</td>
                <td>{{ t.dueDate }}</td>
                <td class="memo">{{ t.memo }}</td>
                <td class="num">{{ fmtMoney(dec(t.amount)) }}</td>
                <td class="num">{{ t.open !== undefined ? fmtMoney(dec(t.open)) : '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.center {
  display: grid;
  grid-template-columns: 20rem minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}
.center__list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
  padding: 0.5rem;
  max-height: calc(100vh - 6rem);
}
.center__search {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.center__rows {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
.center__rows:focus {
  outline: 2px solid var(--p-primary-color);
}
.center__rows li {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.3rem 0.4rem;
  cursor: pointer;
  border-radius: 3px;
}
.center__rows li:hover {
  background: var(--p-content-hover-background);
}
.center__rows li.sel {
  background: var(--p-highlight-background);
  color: var(--p-highlight-color);
}
.nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bal {
  font-variant-numeric: tabular-nums;
}
.center__head h1 {
  margin: 0 0 0.75rem;
  font-size: 1.4rem;
}
.card {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
}
.card h2 {
  margin: 0 0 0.5rem;
  font-size: 1.15rem;
}
.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.15rem 0.75rem;
  margin: 0;
}
.facts dt {
  color: var(--p-text-muted-color);
}
.facts dd {
  margin: 0;
}
.addr {
  display: block;
}
.card__bal {
  text-align: right;
}
.big {
  font-size: 1.6rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0.75rem 0;
}
.action {
  display: inline-flex;
  gap: 0.35rem;
  align-items: center;
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 999px;
  color: var(--p-text-color);
  text-decoration: none;
  background: var(--p-content-background);
}
.action:hover,
.action:focus-visible {
  border-color: var(--p-primary-color);
  color: var(--p-primary-color);
}
.txn-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.4rem;
}
.txn-head h3 {
  margin: 0;
  font-size: 1rem;
}
.in {
  font: inherit;
  color: var(--p-text-color);
  padding: 0.3rem 0.45rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
}
.chk {
  display: flex;
  gap: 0.35rem;
  align-items: center;
  font-size: 0.85rem;
}
.wrap {
  overflow-x: auto;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
}
.t {
  width: 100%;
  border-collapse: collapse;
}
.t th {
  text-align: left;
  font-size: 0.75rem;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
  background: var(--p-content-hover-background);
  padding: 0.35rem 0.5rem;
}
.t td {
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
}
.t tr.link {
  cursor: pointer;
}
.t tr.link:hover td,
.t tr.link:focus td {
  background: var(--p-content-hover-background);
}
.memo {
  max-width: 18rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
}
.muted {
  color: var(--p-text-muted-color);
}
@media (max-width: 900px) {
  .center {
    grid-template-columns: 1fr;
  }
}
</style>
