<script setup lang="ts">
/** Top-bar search across the main lists and transactions of the read model. */
import AutoComplete from 'primevue/autocomplete';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { objectsApi } from '@/api/endpoints';
import type { QbObject } from '@/api/types';
import { formatMoney } from '@/lib/format';
import { humanize } from '@/lib/labels';
import { entityDetailRoute } from '@/lib/links';
import { useAuthStore } from '@/stores/auth';
import { useMetaStore } from '@/stores/meta';

/** Types searched, in result order. */
const SEARCH_TYPES = [
  'Customer',
  'Vendor',
  'Employee',
  'OtherName',
  'Invoice',
  'Estimate',
  'SalesOrder',
  'SalesReceipt',
  'CreditMemo',
  'ReceivePayment',
  'Bill',
  'PurchaseOrder',
  'Check',
  'JournalEntry',
  'Deposit',
  'Account',
  'ItemService',
  'ItemInventory',
  'ItemNonInventory',
  'ItemOtherCharge',
];

interface Hit {
  type: string;
  row: QbObject;
  label: string;
  sub: string;
}
interface Group {
  label: string;
  items: Hit[];
}

const router = useRouter();
const auth = useAuthStore();
const meta = useMetaStore();
const text = ref<string | Hit>('');
const groups = ref<Group[]>([]);
let seq = 0;

const types = computed(() =>
  SEARCH_TYPES.filter(
    (t) => (meta.entityNames.length ? meta.entityNames.includes(t) : true) && auth.canRead(t),
  ),
);

function describe(type: string, row: QbObject): Hit {
  const isTxn = !!row.txnDate || !!row.refNumber;
  const label = isTxn ? `${humanize(type)} ${row.refNumber ?? ''}`.trim() : (row.name ?? row.id);
  const sub = isTxn
    ? [row.name, row.txnDate, row.amount ? formatMoney(row.amount) : ''].filter(Boolean).join(' · ')
    : String(row.data.CompanyName ?? row.data.Email ?? '');
  return { type, row, label, sub };
}

async function search(e: { query: string }) {
  const q = e.query.trim();
  const my = ++seq;
  if (q.length < 2) {
    groups.value = [];
    return;
  }
  const results = await Promise.all(
    types.value.map((t) =>
      objectsApi
        .list(t, { q, pageSize: 5 })
        .then((p) => ({ t, items: p.items }))
        .catch(() => ({ t, items: [] as QbObject[] })),
    ),
  );
  if (my !== seq) return;
  groups.value = results
    .filter((r) => r.items.length)
    .map((r) => ({ label: humanize(r.t), items: r.items.map((row) => describe(r.t, row)) }));
}

function go(e: { value: Hit }) {
  text.value = '';
  groups.value = [];
  void router.push(entityDetailRoute(e.value.type, e.value.row.id));
}
</script>

<template>
  <AutoComplete
    v-model="text"
    :suggestions="groups"
    option-label="label"
    option-group-label="label"
    option-group-children="items"
    placeholder="Search customers, invoices, items…"
    :delay="300"
    class="global-search"
    input-class="global-search__input"
    aria-label="Global search"
    @complete="search"
    @option-select="go"
  >
    <template #optiongroup="{ option }">
      <strong class="global-search__group">{{ option.label }}</strong>
    </template>
    <template #option="{ option }">
      <div class="global-search__hit">
        <span>{{ option.label }}</span>
        <small v-if="option.sub">{{ option.sub }}</small>
      </div>
    </template>
    <template #empty>No matches</template>
  </AutoComplete>
</template>

<style scoped>
.global-search {
  width: min(28rem, 100%);
}
.global-search :deep(.global-search__input) {
  width: 100%;
}
.global-search__hit {
  display: flex;
  flex-direction: column;
}
.global-search__hit small,
.global-search__group {
  color: var(--p-text-muted-color);
}
</style>
