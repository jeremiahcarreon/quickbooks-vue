<script setup lang="ts">
/**
 * Receive Payments: choose the customer, enter the amount, and apply it to
 * open invoices (oldest first), with early-payment discounts and available
 * credit memos. An amount left over stays with the customer as a credit.
 */
import Button from 'primevue/button';
import Message from 'primevue/message';
import { useToast } from 'primevue/usetoast';
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import CommandBanner from '../components/CommandBanner.vue';
import FormFrame from '../components/FormFrame.vue';
import RefPicker from '../components/RefPicker.vue';
import TotalsPanel from '../components/TotalsPanel.vue';
import { getObject, listAll } from '../lib/api';
import { todayIso } from '../lib/calc';
import { dec, fmtAmount, fmtMoney, normAmount, parseDec, ZERO } from '../lib/decimal';
import {
  applyCredits,
  autoApply,
  creditDocFromRow,
  emptyApplication,
  mergeDocs,
  openDocFromRow,
  receivePaymentAddBody,
  receivePaymentFromRet,
  receivePaymentModBody,
  remainingAfterReductions,
  sortOpenDocs,
  summarize,
  toggleDoc,
  type CreditDoc,
  type OpenDoc,
  type ReceivePaymentState,
} from '../lib/payments';
import { rowToRef } from '../lib/refs';
import type { RefValue, TotalRow } from '../lib/types';
import { useCommand } from '../lib/useCommand';
import { useHotkeys } from '../lib/useHotkeys';

const props = defineProps<{ id: string }>();
const route = useRoute();
const router = useRouter();
const toast = useToast();
const mode = computed<'add' | 'mod'>(() => (props.id === 'new' ? 'add' : 'mod'));

const blank = (): ReceivePaymentState => ({
  CustomerRef: null,
  ARAccountRef: null,
  TxnDate: todayIso(),
  RefNumber: '',
  TotalAmount: '',
  PaymentMethodRef: null,
  Memo: '',
  DepositToAccountRef: null,
  DiscountAccountRef: null,
  autoApply: true,
  apps: {},
});

const state = reactive<ReceivePaymentState>(blank());
const docs = ref<OpenDoc[]>([]);
const credits = ref<CreditDoc[]>([]);
const appliedDocs = shallowRef<OpenDoc[]>([]);
const original = shallowRef<Record<string, unknown> | null>(null);
const loadingDocs = ref(false);
const loadError = ref<string | null>(null);
const issues = ref<string[]>([]);
const cmd = useCommand();
const busy = computed(() => cmd.phase.value === 'submitting' || cmd.phase.value === 'pending');

function reset() {
  Object.assign(state, blank());
  docs.value = [];
  credits.value = [];
  appliedDocs.value = [];
  original.value = null;
  issues.value = [];
}

async function loadDocs(customer: RefValue | null) {
  docs.value = mergeDocs([], appliedDocs.value);
  credits.value = [];
  if (!customer?.ListID) return;
  loadingDocs.value = true;
  try {
    const filter = { 'CustomerRef.ListID': customer.ListID, IsPaid: 'false' };
    const [inv, chg, cms] = await Promise.all([
      listAll('Invoice', { filter, sort: 'txn_date' }),
      listAll('Charge', { filter, sort: 'txn_date' }).catch(() => ({ items: [] })),
      listAll('CreditMemo', {
        filter: { 'CustomerRef.ListID': customer.ListID },
        sort: 'txn_date',
      }).catch(() => ({ items: [] })),
    ]);
    const open = [...inv.items, ...chg.items]
      .map(openDocFromRow)
      .filter((d) => dec(d.balance) > ZERO);
    docs.value = mergeDocs(open, appliedDocs.value);
    credits.value = cms.items.map(creditDocFromRow).filter((c) => dec(c.available) > ZERO);
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loadingDocs.value = false;
  }
}

async function load() {
  loadError.value = null;
  reset();
  if (mode.value === 'add') {
    const id = typeof route.query.entity === 'string' ? route.query.entity : null;
    if (id) {
      try {
        const row = await getObject('Customer', id);
        await pickCustomer(rowToRef(row));
      } catch {
        // leave the customer empty
      }
    }
    return;
  }
  try {
    const row = await getObject('ReceivePayment', props.id);
    const loaded = receivePaymentFromRet(row.data);
    Object.assign(state, loaded.state);
    appliedDocs.value = loaded.appliedDocs;
    original.value = row.data;
    await loadDocs(state.CustomerRef);
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  }
}

watch(
  () => props.id,
  () => {
    cmd.resetOnNavigate();
    void load();
  },
  { immediate: true },
);

async function pickCustomer(c: RefValue | null) {
  state.CustomerRef = c;
  state.apps = {};
  await loadDocs(c);
  if (parseDec(state.TotalAmount) !== null) runAutoApply();
}

function runAutoApply() {
  const amount = parseDec(state.TotalAmount);
  if (amount === null) return;
  state.apps = autoApply(docs.value, state.apps, amount).apps;
}

function onAmountBlur() {
  const n = normAmount(state.TotalAmount);
  if (n) state.TotalAmount = n;
  runAutoApply();
}

function app(doc: OpenDoc) {
  return state.apps[doc.TxnID] ?? emptyApplication(doc.TxnID);
}

function setApp(doc: OpenDoc, patch: Partial<ReturnType<typeof app>>) {
  state.apps = { ...state.apps, [doc.TxnID]: { ...app(doc), ...patch, selected: true } };
}

function toggle(doc: OpenDoc, on: boolean) {
  state.apps = { ...state.apps, [doc.TxnID]: toggleDoc(doc, state.apps[doc.TxnID], on) };
}

function useSuggestedDiscount(doc: OpenDoc) {
  if (!doc.suggestedDiscount) return;
  const a = { ...app(doc), discount: normAmount(doc.suggestedDiscount) };
  const owed = remainingAfterReductions(doc, a);
  if (dec(a.payment) > owed) a.payment = owed > ZERO ? fmtAmount(owed) : '';
  setApp(doc, a);
}

function useCredits(doc: OpenDoc) {
  state.apps = {
    ...state.apps,
    [doc.TxnID]: applyCredits(doc, app(doc), credits.value, state.apps),
  };
}

function clearAll() {
  state.apps = {};
}

const discountFor = computed(() =>
  Object.values(state.apps).some((a) => a.selected && dec(a.discount) > ZERO),
);
const summary = computed(() =>
  summarize(docs.value, state.apps, state.TotalAmount, {
    creditDocs: credits.value,
    discountAccount: state.DiscountAccountRef,
  }),
);
const totalDue = computed(() => docs.value.reduce((t, d) => t + dec(d.balance), ZERO));

const totals = computed<TotalRow[]>(() => {
  const s = summary.value;
  const rows: TotalRow[] = [
    { label: 'Amount due', value: fmtMoney(totalDue.value) },
    { label: 'Applied', value: fmtMoney(s.applied) },
    { label: 'Discounts', value: fmtMoney(s.discounts) },
    { label: 'Credits', value: fmtMoney(s.credits) },
    { label: 'Amount received', value: fmtMoney(s.total), strong: true },
  ];
  if (s.unapplied > ZERO)
    rows.push({ label: 'Unused (kept as credit)', value: fmtMoney(s.unapplied) });
  return rows;
});

async function save(next: 'stay' | 'new' = 'stay') {
  if (busy.value) return;
  issues.value = [];
  let body: Record<string, unknown>;
  try {
    body =
      mode.value === 'add'
        ? receivePaymentAddBody(state, docs.value, credits.value)
        : receivePaymentModBody(state, docs.value, credits.value);
  } catch (err) {
    issues.value = (err as { issues?: string[] }).issues ?? [
      err instanceof Error ? err.message : String(err),
    ];
    return;
  }
  const result = await cmd.run(
    'ReceivePayment',
    body,
    mode.value === 'mod' ? state.TxnID : undefined,
    {
      label: `Payment from ${state.CustomerRef?.FullName ?? 'customer'}`,
      base: original.value,
      formObject: 'ReceivePaymentMod',
    },
  );
  if (!result || cmd.phase.value !== 'confirmed') return;
  toast.add({
    severity: 'success',
    summary: 'Saved',
    detail: 'Payment recorded in QuickBooks.',
    life: 3000,
  });
  if (next === 'new') {
    if (mode.value === 'add') reset();
    else await router.push('/transactions/receive-payment/new');
    return;
  }
  const id = cmd.createdId() ?? state.TxnID;
  if (mode.value === 'add' && id) {
    cmd.hold();
    await router.replace(`/transactions/receive-payment/${encodeURIComponent(id)}`);
  } else void load();
}

function reapply() {
  const cur = cmd.current();
  if (cur && typeof cur.EditSequence === 'string') state.EditSequence = cur.EditSequence;
  cmd.reset();
  void save();
}

function close() {
  if (window.history.length > 1) router.back();
  else void router.push('/');
}

useHotkeys({ save: () => void save('stay'), saveNew: () => void save('new') });

const sortedDocs = computed(() => sortOpenDocs(docs.value));
</script>

<template>
  <FormFrame
    title="Receive Payments"
    :subtitle="state.CustomerRef?.FullName"
    :mode="mode"
    :busy="busy"
    @save="save('stay')"
    @save-new="save('new')"
    @revert="load()"
    @close="close"
  >
    <template #status>
      <Message v-if="loadError" severity="error" :closable="false">{{ loadError }}</Message>
      <CommandBanner
        :phase="cmd.phase.value"
        :command="cmd.command.value"
        :error="cmd.error.value"
        :issues="issues.length ? issues : undefined"
        subject="the payment"
        @reapply="reapply"
        @discard="load()"
        @dismiss="cmd.reset()"
      />
    </template>
    <template #header>
      <div class="rp-hdr">
        <label class="f f--wide">
          <span>Received from<span class="req" aria-hidden="true">*</span></span>
          <RefPicker
            :model-value="state.CustomerRef"
            source="Customer"
            input-id="rp-customer"
            compact
            @update:model-value="pickCustomer"
          />
        </label>
        <label class="f">
          <span>Payment amount</span>
          <input
            id="rp-amount"
            v-model="state.TotalAmount"
            class="in num"
            inputmode="decimal"
            @blur="onAmountBlur"
          />
        </label>
        <label class="f">
          <span>Date</span>
          <input v-model="state.TxnDate" type="date" class="in" />
        </label>
        <label class="f">
          <span>Payment method</span>
          <RefPicker v-model="state.PaymentMethodRef" source="PaymentMethod" compact />
        </label>
        <label class="f">
          <span>Check / ref no.</span>
          <input v-model="state.RefNumber" class="in" maxlength="20" />
        </label>
        <label class="f">
          <span>Deposit to</span>
          <RefPicker v-model="state.DepositToAccountRef" source="DepositAccount" compact />
        </label>
        <label class="f">
          <span>A/R account</span>
          <RefPicker v-model="state.ARAccountRef" source="ARAccount" compact />
        </label>
      </div>
    </template>
    <template #lines>
      <div class="rp-tools">
        <Button
          size="small"
          severity="secondary"
          label="Auto apply payment"
          icon="pi pi-bolt"
          :disabled="!docs.length"
          @click="runAutoApply"
        />
        <Button
          size="small"
          severity="secondary"
          text
          label="Clear payments"
          :disabled="!Object.keys(state.apps).length"
          @click="clearAll"
        />
        <span v-if="credits.length" class="muted">
          Available credits: {{ fmtMoney(credits.reduce((t, c) => t + dec(c.available), 0n)) }}
        </span>
      </div>
      <div class="wrap">
        <table class="docs" aria-label="Open invoices">
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">Apply</span></th>
              <th scope="col">Date</th>
              <th scope="col">Number</th>
              <th scope="col">Due</th>
              <th scope="col" class="num">Orig. amt.</th>
              <th scope="col" class="num">Amt. due</th>
              <th scope="col" class="num">Discount</th>
              <th scope="col" class="num">Credits</th>
              <th scope="col" class="num">Payment</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!state.CustomerRef">
              <td colspan="9" class="muted">Choose a customer to see open invoices.</td>
            </tr>
            <tr v-else-if="loadingDocs">
              <td colspan="9" class="muted">Loading open invoices...</td>
            </tr>
            <tr v-else-if="!docs.length">
              <td colspan="9" class="muted">
                No open invoices. The payment will be kept as a credit.
              </td>
            </tr>
            <tr v-for="d in sortedDocs" :key="d.TxnID" :class="{ sel: app(d).selected }">
              <td>
                <input
                  type="checkbox"
                  :aria-label="`Apply to ${d.RefNumber ?? d.TxnID}`"
                  :checked="app(d).selected"
                  @change="toggle(d, ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td>{{ d.TxnDate }}</td>
              <td>
                {{ d.RefNumber }}
                <small v-if="d.type !== 'Invoice'" class="muted">{{ d.type }}</small>
              </td>
              <td>{{ d.DueDate }}</td>
              <td class="num">{{ fmtMoney(dec(d.original)) }}</td>
              <td class="num">{{ fmtMoney(dec(d.balance)) }}</td>
              <td class="num">
                <input
                  class="cell num"
                  inputmode="decimal"
                  :aria-label="`Discount for ${d.RefNumber ?? d.TxnID}`"
                  :value="app(d).discount"
                  :title="
                    d.suggestedDiscount
                      ? `Suggested ${d.suggestedDiscount} until ${d.suggestedDiscountDate ?? ''}`
                      : undefined
                  "
                  @change="
                    setApp(d, { discount: normAmount(($event.target as HTMLInputElement).value) })
                  "
                />
                <button
                  v-if="d.suggestedDiscount && !app(d).discount"
                  type="button"
                  class="link"
                  @click="useSuggestedDiscount(d)"
                >
                  use {{ d.suggestedDiscount }}
                </button>
              </td>
              <td class="num">
                <span v-if="app(d).credits.length">{{
                  fmtMoney(app(d).credits.reduce((t, c) => t + dec(c.AppliedAmount), 0n))
                }}</span>
                <button
                  v-else-if="credits.length"
                  type="button"
                  class="link"
                  @click="useCredits(d)"
                >
                  apply
                </button>
              </td>
              <td class="num">
                <input
                  class="cell num"
                  inputmode="decimal"
                  :aria-label="`Payment for ${d.RefNumber ?? d.TxnID}`"
                  :value="app(d).payment"
                  @change="
                    setApp(d, { payment: normAmount(($event.target as HTMLInputElement).value) })
                  "
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <template #footer>
      <div class="rp-foot">
        <label v-if="discountFor" class="f">
          <span>Discount account<span class="req" aria-hidden="true">*</span></span>
          <RefPicker v-model="state.DiscountAccountRef" source="Account" compact />
        </label>
        <label class="f f--memo">
          <span>Memo</span>
          <textarea v-model="state.Memo" class="in" rows="2" maxlength="4095" />
        </label>
        <label
          v-if="mode === 'add' && docs.length && !Object.values(state.apps).some((a) => a.selected)"
          class="chk"
        >
          <input v-model="state.autoApply" type="checkbox" />
          <span>Let QuickBooks apply the payment when none is applied here</span>
        </label>
      </div>
    </template>
    <template #totals>
      <TotalsPanel :rows="totals" />
    </template>
  </FormFrame>
</template>

<style scoped>
.rp-hdr {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
  gap: 0.5rem 0.75rem;
  align-items: end;
}
.f {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  min-width: 0;
}
.f--wide {
  grid-column: span 2;
}
.f--memo {
  max-width: 40rem;
}
.req {
  color: var(--p-red-500);
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
.rp-tools {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.4rem;
}
.rp-foot {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.chk {
  display: flex;
  gap: 0.4rem;
  align-items: center;
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
  font-size: 0.8rem;
  padding: 0 0.25rem;
}
.muted {
  color: var(--p-text-muted-color);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
