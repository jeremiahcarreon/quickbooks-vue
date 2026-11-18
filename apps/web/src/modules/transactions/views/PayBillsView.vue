<script setup lang="ts">
/**
 * Pay Bills: select open bills (optionally with discounts and vendor
 * credits), choose how to pay, and create one bill payment per vendor.
 */
import Button from 'primevue/button';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import { useToast } from 'primevue/usetoast';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import CommandBanner from '../components/CommandBanner.vue';
import FormFrame from '../components/FormFrame.vue';
import RefPicker from '../components/RefPicker.vue';
import TotalsPanel from '../components/TotalsPanel.vue';
import { listAll } from '../lib/api';
import { todayIso } from '../lib/calc';
import { dec, fmtAmount, fmtMoney, normAmount, ZERO } from '../lib/decimal';
import {
  applyCredits,
  creditDocFromRow,
  emptyApplication,
  openDocFromRow,
  payBillsBodies,
  remainingAfterReductions,
  sortOpenDocs,
  summarize,
  toggleDoc,
  type Application,
  type CreditDoc,
  type OpenDoc,
  type PayBillsState,
} from '../lib/payments';
import { refIn, sameRef } from '../lib/refs';
import type { RefValue, TotalRow } from '../lib/types';
import { useCommand } from '../lib/useCommand';
import { useHotkeys } from '../lib/useHotkeys';

const router = useRouter();
const toast = useToast();
const cmd = useCommand();

const state = reactive<PayBillsState>({
  TxnDate: todayIso(),
  method: 'check',
  BankAccountRef: null,
  CreditCardAccountRef: null,
  APAccountRef: null,
  toBePrinted: true,
  firstCheckNumber: '',
  Memo: '',
  DiscountAccountRef: null,
  apps: {},
});
const bills = ref<OpenDoc[]>([]);
const vendorCredits = ref<(CreditDoc & { vendor: RefValue | null })[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const issues = ref<string[]>([]);
const showAll = ref(true);
const dueBy = ref(todayIso());
const vendorFilter = ref<RefValue | null>(null);
const results = ref<{ vendor: string; amount: string; status: string; message?: string }[]>([]);
const running = ref(false);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const [b, vc] = await Promise.all([
      listAll('Bill', { filter: { IsPaid: 'false' }, sort: 'txn_date' }),
      listAll('VendorCredit', { sort: 'txn_date' }).catch(() => ({ items: [] })),
    ]);
    bills.value = sortOpenDocs(b.items.map(openDocFromRow).filter((d) => dec(d.balance) > ZERO));
    vendorCredits.value = vc.items
      .map((r) => ({ ...creditDocFromRow(r), vendor: refIn(r.data.VendorRef) }))
      .filter((c) => dec(c.available) > ZERO);
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const visible = computed(() =>
  bills.value.filter(
    (b) =>
      (showAll.value || !b.DueDate || b.DueDate <= dueBy.value) &&
      (!vendorFilter.value || sameRef(b.entity, vendorFilter.value)),
  ),
);

function app(b: OpenDoc): Application {
  return state.apps[b.TxnID] ?? emptyApplication(b.TxnID);
}

function toggle(b: OpenDoc, on: boolean) {
  state.apps = { ...state.apps, [b.TxnID]: toggleDoc(b, state.apps[b.TxnID], on) };
}

function setApp(b: OpenDoc, patch: Partial<Application>) {
  const next = { ...app(b), ...patch, selected: true };
  if (patch.discount !== undefined) {
    const owed = remainingAfterReductions(b, next);
    if (dec(next.payment) > owed) next.payment = owed > ZERO ? fmtAmount(owed) : '';
  }
  state.apps = { ...state.apps, [b.TxnID]: next };
}

function creditsFor(b: OpenDoc) {
  return vendorCredits.value.filter((c) => sameRef(c.vendor, b.entity));
}

function useCredits(b: OpenDoc) {
  state.apps = { ...state.apps, [b.TxnID]: applyCredits(b, app(b), creditsFor(b), state.apps) };
}

function selectAll(on: boolean) {
  const next = { ...state.apps };
  for (const b of visible.value) next[b.TxnID] = toggleDoc(b, next[b.TxnID], on);
  state.apps = next;
}

const summary = computed(() =>
  summarize(bills.value, state.apps, '', { discountAccount: state.DiscountAccountRef }),
);
const selectedCount = computed(
  () => bills.value.filter((b) => state.apps[b.TxnID]?.selected).length,
);
const vendorCount = computed(
  () =>
    new Set(
      bills.value
        .filter((b) => state.apps[b.TxnID]?.selected)
        .map((b) => b.entity?.ListID ?? b.entity?.FullName),
    ).size,
);
const hasDiscount = computed(() =>
  Object.values(state.apps).some((a) => a.selected && dec(a.discount) > ZERO),
);

const totals = computed<TotalRow[]>(() => [
  {
    label: 'Bills selected',
    value: `${selectedCount.value} (${vendorCount.value} vendor${vendorCount.value === 1 ? '' : 's'})`,
  },
  { label: 'Discounts', value: fmtMoney(summary.value.discounts) },
  { label: 'Credits', value: fmtMoney(summary.value.credits) },
  { label: 'Total to pay', value: fmtMoney(summary.value.applied), strong: true },
]);

async function pay() {
  if (running.value) return;
  issues.value = [];
  results.value = [];
  let requests;
  try {
    requests = payBillsBodies(state, bills.value, vendorCredits.value);
  } catch (err) {
    issues.value = (err as { issues?: string[] }).issues ?? [
      err instanceof Error ? err.message : String(err),
    ];
    return;
  }
  running.value = true;
  try {
    for (const r of requests) {
      const c = await cmd.run(r.type, r.body, undefined, {
        label: `Bill payment to ${r.vendor.FullName ?? ''}`,
      });
      results.value.push({
        vendor: r.vendor.FullName ?? r.vendor.ListID ?? '',
        amount: fmtMoney(r.amount),
        status: c ? cmd.phase.value : 'failed',
        message: cmd.error.value ?? undefined,
      });
      if (!c || cmd.phase.value === 'failed') break;
    }
  } finally {
    running.value = false;
  }
  const ok = results.value.filter((r) => r.status === 'confirmed').length;
  if (ok) {
    toast.add({
      severity: 'success',
      summary: 'Bills paid',
      detail: `${ok} payment(s) recorded in QuickBooks.`,
      life: 4000,
    });
    state.apps = {};
    await load();
  }
}

function close() {
  if (window.history.length > 1) router.back();
  else void router.push('/');
}

useHotkeys({ save: () => void pay() });
</script>

<template>
  <FormFrame
    title="Pay Bills"
    mode="add"
    :busy="running"
    :can-save-new="false"
    @save="pay"
    @revert="state.apps = {}"
    @close="close"
  >
    <template #status>
      <Message v-if="loadError" severity="error" :closable="false">{{ loadError }}</Message>
      <CommandBanner
        :phase="running ? cmd.phase.value : 'idle'"
        :command="cmd.command.value"
        :error="cmd.error.value"
        :issues="issues.length ? issues : undefined"
      />
      <Message
        v-if="results.length"
        :severity="results.every((r) => r.status === 'confirmed') ? 'success' : 'warn'"
        :closable="false"
      >
        <ul class="res">
          <li v-for="r in results" :key="r.vendor">
            <Tag
              :severity="
                r.status === 'confirmed' ? 'success' : r.status === 'pending' ? 'info' : 'danger'
              "
              :value="r.status"
            />
            {{ r.vendor }}: {{ r.amount }}
            <span v-if="r.message && r.status !== 'confirmed'">({{ r.message }})</span>
          </li>
        </ul>
      </Message>
    </template>
    <template #header>
      <div class="pb-hdr">
        <fieldset class="pb-show">
          <legend>Show bills</legend>
          <label
            ><input v-model="showAll" type="radio" :value="false" /> Due on or before
            <input v-model="dueBy" type="date" class="in" :disabled="showAll"
          /></label>
          <label><input v-model="showAll" type="radio" :value="true" /> All bills</label>
        </fieldset>
        <label class="f">
          <span>Vendor</span>
          <RefPicker v-model="vendorFilter" source="Vendor" placeholder="All vendors" compact />
        </label>
      </div>
    </template>
    <template #lines>
      <div class="pb-tools">
        <Button
          size="small"
          severity="secondary"
          label="Select all"
          :disabled="!visible.length"
          @click="selectAll(true)"
        />
        <Button
          size="small"
          severity="secondary"
          text
          label="Clear selections"
          @click="selectAll(false)"
        />
        <span v-if="loading" class="muted">Loading open bills...</span>
      </div>
      <div class="wrap">
        <table class="docs" aria-label="Open bills">
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">Pay</span></th>
              <th scope="col">Date due</th>
              <th scope="col">Vendor</th>
              <th scope="col">Ref. no.</th>
              <th scope="col" class="num">Amt. due</th>
              <th scope="col" class="num">Discount</th>
              <th scope="col" class="num">Credits</th>
              <th scope="col" class="num">Amt. to pay</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!loading && !visible.length">
              <td colspan="8" class="muted">No open bills.</td>
            </tr>
            <tr v-for="b in visible" :key="b.TxnID" :class="{ sel: app(b).selected }">
              <td>
                <input
                  type="checkbox"
                  :aria-label="`Pay bill ${b.RefNumber ?? b.TxnID}`"
                  :checked="app(b).selected"
                  @change="toggle(b, ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td>{{ b.DueDate ?? b.TxnDate }}</td>
              <td>{{ b.entity?.FullName }}</td>
              <td>{{ b.RefNumber }}</td>
              <td class="num">{{ fmtMoney(dec(b.balance)) }}</td>
              <td class="num">
                <input
                  class="cell num"
                  inputmode="decimal"
                  :aria-label="`Discount for bill ${b.RefNumber ?? b.TxnID}`"
                  :value="app(b).discount"
                  @change="
                    setApp(b, { discount: normAmount(($event.target as HTMLInputElement).value) })
                  "
                />
              </td>
              <td class="num">
                <span v-if="app(b).credits.length">{{
                  fmtMoney(app(b).credits.reduce((t, c) => t + dec(c.AppliedAmount), 0n))
                }}</span>
                <button
                  v-else-if="creditsFor(b).length"
                  type="button"
                  class="link"
                  @click="useCredits(b)"
                >
                  apply
                </button>
              </td>
              <td class="num">
                <input
                  class="cell num"
                  inputmode="decimal"
                  :aria-label="`Amount to pay for bill ${b.RefNumber ?? b.TxnID}`"
                  :value="app(b).payment"
                  @change="
                    setApp(b, { payment: normAmount(($event.target as HTMLInputElement).value) })
                  "
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <template #footer>
      <div class="pb-pay">
        <label class="f">
          <span>Payment date</span>
          <input v-model="state.TxnDate" type="date" class="in" />
        </label>
        <fieldset class="pb-show">
          <legend>Method</legend>
          <label><input v-model="state.method" type="radio" value="check" /> Check</label>
          <label
            ><input v-model="state.method" type="radio" value="creditcard" /> Credit card</label
          >
        </fieldset>
        <label v-if="state.method === 'check'" class="f">
          <span>Payment account<span class="req" aria-hidden="true">*</span></span>
          <RefPicker v-model="state.BankAccountRef" source="BankAccount" compact />
        </label>
        <label v-else class="f">
          <span>Credit card<span class="req" aria-hidden="true">*</span></span>
          <RefPicker v-model="state.CreditCardAccountRef" source="CreditCardAccount" compact />
        </label>
        <template v-if="state.method === 'check'">
          <label class="chk"
            ><input v-model="state.toBePrinted" type="checkbox" /> To be printed</label
          >
          <label v-if="!state.toBePrinted" class="f">
            <span>First check no.</span>
            <input v-model="state.firstCheckNumber" class="in" maxlength="11" />
          </label>
        </template>
        <label class="f">
          <span>A/P account</span>
          <RefPicker v-model="state.APAccountRef" source="APAccount" compact />
        </label>
        <label v-if="hasDiscount" class="f">
          <span>Discount account<span class="req" aria-hidden="true">*</span></span>
          <RefPicker v-model="state.DiscountAccountRef" source="Account" compact />
        </label>
        <label class="f">
          <span>Memo</span>
          <input v-model="state.Memo" class="in" maxlength="4095" />
        </label>
      </div>
    </template>
    <template #totals>
      <TotalsPanel :rows="totals" />
    </template>
  </FormFrame>
</template>

<style scoped>
.pb-hdr,
.pb-pay {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  align-items: end;
}
.pb-show {
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  display: flex;
  gap: 1rem;
  padding: 0.25rem 0.75rem 0.5rem;
  margin: 0;
}
.pb-show legend {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.pb-tools {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.4rem;
}
.f {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  min-width: 12rem;
}
.req {
  color: var(--p-red-500);
}
.chk {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  padding-bottom: 0.4rem;
}
.in {
  font: inherit;
  font-size: 0.95rem;
  color: var(--p-text-color);
  padding: 0.3rem 0.45rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
}
.wrap {
  overflow-x: auto;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
}
.docs {
  width: 100%;
  border-collapse: collapse;
}
.docs th {
  text-align: left;
  font-size: 0.75rem;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
  background: var(--p-content-hover-background);
  padding: 0.35rem 0.5rem;
}
.docs td {
  padding: 0.2rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
}
.docs .sel td {
  background: color-mix(in srgb, var(--p-primary-color) 7%, transparent);
}
.num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
}
.cell {
  width: 7rem;
  font: inherit;
  border: 1px solid var(--p-content-border-color);
  border-radius: 3px;
  background: var(--p-content-background);
  color: var(--p-text-color);
  padding: 0.2rem 0.3rem;
}
.link {
  border: 0;
  background: none;
  color: var(--p-primary-color);
  cursor: pointer;
}
.muted {
  color: var(--p-text-muted-color);
}
.res {
  margin: 0;
  padding-left: 1rem;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
