<script setup lang="ts">
/**
 * Make Deposits: pick payments waiting in Undeposited Funds and/or add
 * other deposit lines, then deposit them to a bank account.
 */
import Message from 'primevue/message';
import { useToast } from 'primevue/usetoast';
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import CommandBanner from '../components/CommandBanner.vue';
import FormFrame from '../components/FormFrame.vue';
import RefPicker from '../components/RefPicker.vue';
import TotalsPanel from '../components/TotalsPanel.vue';
import { getObject, listAll } from '../lib/api';
import { todayIso } from '../lib/calc';
import { dec, fmtMoney, normAmount } from '../lib/decimal';
import {
  blankDepositLine,
  depositAddBody,
  depositFromRet,
  depositModBody,
  depositPaymentFromRow,
  depositTotal,
  isBlankDepositLine,
  type DepositState,
} from '../lib/deposit';
import type { TotalRow } from '../lib/types';
import { useCommand } from '../lib/useCommand';
import { useHotkeys } from '../lib/useHotkeys';

const props = defineProps<{ id: string }>();
const router = useRouter();
const toast = useToast();
const cmd = useCommand();
const mode = computed<'add' | 'mod'>(() => (props.id === 'new' ? 'add' : 'mod'));
const busy = computed(() => cmd.phase.value === 'submitting' || cmd.phase.value === 'pending');

const blank = (): DepositState => ({
  TxnDate: todayIso(),
  DepositToAccountRef: null,
  Memo: '',
  payments: [],
  lines: [blankDepositLine()],
});
const state = reactive<DepositState>(blank());
const original = shallowRef<Record<string, unknown> | null>(null);
const loadError = ref<string | null>(null);
const loadingPayments = ref(false);
const paymentsNote = ref<string | null>(null);
const issues = ref<string[]>([]);

/**
 * Payments in Undeposited Funds that no deposit references yet. The read
 * model has no "deposited" flag, so recent deposits are checked for the
 * payment TxnIDs they already include.
 */
async function loadUndeposited() {
  loadingPayments.value = true;
  paymentsNote.value = null;
  try {
    const filter = { 'DepositToAccountRef.FullName': 'Undeposited Funds' };
    const [rp, sr] = await Promise.all([
      listAll('ReceivePayment', { filter, sort: '-txn_date' }, 1000),
      listAll('SalesReceipt', { filter, sort: '-txn_date' }, 1000),
    ]);
    const candidates = [...rp.items, ...sr.items].map(depositPaymentFromRow);
    const earliest = candidates
      .map((c) => c.TxnDate ?? '')
      .filter(Boolean)
      .sort()[0];
    const deposited = new Set<string>();
    if (earliest) {
      const deps = await listAll('Deposit', { filter: { TxnDate: `gte:${earliest}` } }, 2000);
      for (const d of deps.items) {
        const lines = d.data.DepositLineRet;
        for (const l of Array.isArray(lines) ? lines : lines ? [lines] : []) {
          const id = (l as Record<string, unknown>).TxnID;
          if (typeof id === 'string') deposited.add(id);
        }
      }
    }
    state.payments = candidates.filter((c) => !deposited.has(c.TxnID) && dec(c.amount) > 0n);
    if (rp.truncated || sr.truncated)
      paymentsNote.value = 'Only the most recent 1,000 payments of each kind are listed.';
  } catch (err) {
    paymentsNote.value = `Could not list undeposited payments: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    loadingPayments.value = false;
  }
}

async function load() {
  loadError.value = null;
  issues.value = [];
  if (mode.value === 'add') {
    Object.assign(state, blank());
    original.value = null;
    await loadUndeposited();
    return;
  }
  try {
    const row = await getObject('Deposit', props.id);
    Object.assign(state, depositFromRet(row.data));
    state.lines.push(blankDepositLine());
    original.value = row.data;
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

watch(
  () => state.lines.map(isBlankDepositLine),
  (b) => {
    if (!b.length || !b[b.length - 1]) state.lines.push(blankDepositLine());
  },
);

const selectedPayments = computed(() => state.payments.filter((p) => p.selected));
const totals = computed<TotalRow[]>(() => [
  { label: 'Payments selected', value: `${selectedPayments.value.length}` },
  { label: 'Deposit total', value: fmtMoney(depositTotal(state)), strong: true },
]);

function removeLine(i: number) {
  state.lines.splice(i, 1);
}

async function save(next: 'stay' | 'new' = 'stay') {
  if (busy.value) return;
  issues.value = [];
  let body: Record<string, unknown>;
  try {
    body = mode.value === 'add' ? depositAddBody(state) : depositModBody(state);
  } catch (err) {
    issues.value = (err as { issues?: string[] }).issues ?? [
      err instanceof Error ? err.message : String(err),
    ];
    return;
  }
  const c = await cmd.run('Deposit', body, mode.value === 'mod' ? state.TxnID : undefined, {
    label: 'Deposit',
    base: original.value,
    formObject: 'DepositMod',
  });
  if (!c || cmd.phase.value !== 'confirmed') return;
  toast.add({
    severity: 'success',
    summary: 'Saved',
    detail: 'Deposit recorded in QuickBooks.',
    life: 3000,
  });
  if (next === 'new') {
    if (mode.value === 'add') await load();
    else await router.push('/transactions/deposit/new');
    return;
  }
  const id = cmd.createdId() ?? state.TxnID;
  if (mode.value === 'add' && id) {
    cmd.hold();
    await router.replace(`/transactions/deposit/${encodeURIComponent(id)}`);
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
</script>

<template>
  <FormFrame
    title="Make Deposits"
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
        subject="the deposit"
        @reapply="reapply"
        @discard="load()"
        @dismiss="cmd.reset()"
      />
    </template>
    <template #header>
      <div class="dp-hdr">
        <label class="f f--wide">
          <span>Deposit to<span class="req" aria-hidden="true">*</span></span>
          <RefPicker
            v-model="state.DepositToAccountRef"
            source="BankAccount"
            input-id="dp-account"
            compact
          />
        </label>
        <label class="f">
          <span>Date</span>
          <input v-model="state.TxnDate" type="date" class="in" />
        </label>
        <label class="f f--wide">
          <span>Memo</span>
          <input v-model="state.Memo" class="in" maxlength="4095" />
        </label>
      </div>
    </template>
    <template #lines>
      <section v-if="mode === 'add'" class="sec">
        <h2>Payments to deposit</h2>
        <p v-if="paymentsNote" class="muted">{{ paymentsNote }}</p>
        <div class="wrap">
          <table class="t" aria-label="Payments to deposit">
            <thead>
              <tr>
                <th scope="col"><span class="sr-only">Select</span></th>
                <th scope="col">Date</th>
                <th scope="col">Type</th>
                <th scope="col">No.</th>
                <th scope="col">Received from</th>
                <th scope="col">Pmt. method</th>
                <th scope="col" class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loadingPayments">
                <td colspan="7" class="muted">Loading payments...</td>
              </tr>
              <tr v-else-if="!state.payments.length">
                <td colspan="7" class="muted">No payments are waiting in Undeposited Funds.</td>
              </tr>
              <tr v-for="p in state.payments" :key="p.TxnID">
                <td>
                  <input
                    v-model="p.selected"
                    type="checkbox"
                    :aria-label="`Deposit payment ${p.RefNumber ?? p.TxnID}`"
                  />
                </td>
                <td>{{ p.TxnDate }}</td>
                <td>{{ p.type === 'SalesReceipt' ? 'Sales receipt' : 'Payment' }}</td>
                <td>{{ p.RefNumber }}</td>
                <td>{{ p.entity?.FullName }}</td>
                <td>{{ p.paymentMethod?.FullName }}</td>
                <td class="num">{{ fmtMoney(dec(p.amount)) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="sec">
        <h2>Other deposit lines</h2>
        <div class="wrap">
          <table class="t" aria-label="Deposit lines">
            <thead>
              <tr>
                <th scope="col">Received from</th>
                <th scope="col">From account</th>
                <th scope="col">Memo</th>
                <th scope="col">Chk no.</th>
                <th scope="col">Pmt. meth.</th>
                <th scope="col">Class</th>
                <th scope="col" class="num">Amount</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(l, i) in state.lines" :key="l.key">
                <template v-if="l.paymentTxnID">
                  <td>{{ l.EntityRef?.FullName }}</td>
                  <td colspan="5" class="muted">Payment deposited from Undeposited Funds</td>
                  <td class="num">{{ fmtMoney(dec(l.Amount)) }}</td>
                </template>
                <template v-else>
                  <td>
                    <RefPicker
                      v-model="l.EntityRef"
                      source="Entity"
                      placeholder=" "
                      :aria-label="`Line ${i + 1} received from`"
                      compact
                    />
                  </td>
                  <td>
                    <RefPicker
                      v-model="l.AccountRef"
                      source="Account"
                      placeholder=" "
                      :aria-label="`Line ${i + 1} from account`"
                      compact
                    />
                  </td>
                  <td>
                    <input
                      v-model="l.Memo"
                      class="cell"
                      maxlength="4095"
                      :aria-label="`Line ${i + 1} memo`"
                    />
                  </td>
                  <td>
                    <input
                      v-model="l.CheckNumber"
                      class="cell"
                      maxlength="11"
                      :aria-label="`Line ${i + 1} check number`"
                    />
                  </td>
                  <td>
                    <RefPicker
                      v-model="l.PaymentMethodRef"
                      source="PaymentMethod"
                      placeholder=" "
                      :aria-label="`Line ${i + 1} payment method`"
                      compact
                    />
                  </td>
                  <td>
                    <RefPicker
                      v-model="l.ClassRef"
                      source="Class"
                      placeholder=" "
                      :aria-label="`Line ${i + 1} class`"
                      compact
                    />
                  </td>
                  <td>
                    <input
                      v-model="l.Amount"
                      class="cell num"
                      inputmode="decimal"
                      :aria-label="`Line ${i + 1} amount`"
                      @blur="l.Amount = normAmount(l.Amount) || l.Amount"
                    />
                  </td>
                </template>
                <td>
                  <button
                    v-if="!isBlankDepositLine(l)"
                    type="button"
                    class="del"
                    :aria-label="`Remove line ${i + 1}`"
                    @click="removeLine(i)"
                  >
                    <i class="pi pi-times" aria-hidden="true" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
    <template #totals>
      <TotalsPanel :rows="totals" />
    </template>
  </FormFrame>
</template>

<style scoped>
.dp-hdr {
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
.sec h2 {
  font-size: 0.95rem;
  margin: 0 0 0.3rem;
}
.sec + .sec {
  margin-top: 0.75rem;
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
  padding: 1px 4px;
  border-bottom: 1px solid var(--p-content-border-color);
}
.num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
}
.cell {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  border: 1px solid transparent;
  background: transparent;
  color: var(--p-text-color);
  padding: 0.3rem 0.35rem;
}
.cell:focus {
  outline: none;
  border-color: var(--p-primary-color);
}
.del {
  border: 0;
  background: transparent;
  cursor: pointer;
  color: var(--p-text-muted-color);
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
