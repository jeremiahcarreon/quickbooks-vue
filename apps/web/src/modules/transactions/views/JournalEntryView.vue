<script setup lang="ts">
/** General Journal Entry: debits must equal credits before it can be saved. */
import Message from 'primevue/message';
import Skeleton from 'primevue/skeleton';
import { useToast } from 'primevue/usetoast';
import { computed, nextTick, reactive, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import CommandBanner from '../components/CommandBanner.vue';
import FormFrame from '../components/FormFrame.vue';
import RefPicker from '../components/RefPicker.vue';
import TotalsPanel from '../components/TotalsPanel.vue';
import { getObject } from '../lib/api';
import { todayIso } from '../lib/calc';
import { fmtMoney, normAmount } from '../lib/decimal';
import {
  balancingAmount,
  blankJournalLine,
  isBlankJournalLine,
  journalAddBody,
  journalBalance,
  journalFromRet,
  journalModBody,
  type JournalLine,
  type JournalState,
} from '../lib/journal';
import type { RefValue, TotalRow } from '../lib/types';
import { useCommand } from '../lib/useCommand';
import { useHotkeys } from '../lib/useHotkeys';

const props = defineProps<{ id: string }>();
const router = useRouter();
const toast = useToast();
const mode = computed<'add' | 'mod'>(() => (props.id === 'new' ? 'add' : 'mod'));

const state = reactive<JournalState>({ TxnDate: todayIso(), RefNumber: '', Memo: '', lines: [] });
const original = shallowRef<Record<string, unknown> | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const issues = ref<string[]>([]);
const cmd = useCommand();
const table = ref<HTMLTableElement | null>(null);
const busy = computed(() => cmd.phase.value === 'submitting' || cmd.phase.value === 'pending');

const balance = computed(() => journalBalance(state.lines));
const BILLABLE = ['Billable', 'NotBillable', 'HasBeenBilled'];

function fresh() {
  state.TxnID = undefined;
  state.EditSequence = undefined;
  state.TxnDate = todayIso();
  state.RefNumber = '';
  state.Memo = '';
  state.IsAdjustment = undefined;
  state.lines = [blankJournalLine(), blankJournalLine()];
  original.value = null;
  issues.value = [];
}

function loadInto(ret: Record<string, unknown>) {
  Object.assign(state, journalFromRet(ret));
  state.lines = [...state.lines, blankJournalLine()];
  original.value = ret;
  issues.value = [];
}

async function load() {
  loadError.value = null;
  if (mode.value === 'add') return fresh();
  loading.value = true;
  try {
    loadInto((await getObject('JournalEntry', props.id)).data);
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
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
  () => state.lines.map((l) => isBlankJournalLine(l)),
  (blank) => {
    if (blank.length === 0 || !blank[blank.length - 1]) state.lines.push(blankJournalLine());
  },
  { deep: true },
);

function setAmount(line: JournalLine, side: 'debit' | 'credit', value: string) {
  line[side] = value;
  // A line is either a debit or a credit.
  if (value.trim()) line[side === 'debit' ? 'credit' : 'debit'] = '';
}

function onAccount(i: number, v: RefValue | null) {
  const line = state.lines[i];
  if (!line) return;
  line.AccountRef = v;
  // Like QuickBooks, a new line starts with the amount that balances the entry.
  if (v && !line.debit.trim() && !line.credit.trim()) {
    const others = state.lines.filter((_, j) => j !== i);
    const bal = balancingAmount(others);
    if (bal) line[bal.side] = bal.amount;
  }
}

async function focus(row: number, col: number) {
  await nextTick();
  const el = table.value?.querySelector<HTMLElement>(`[data-cell="r${row}c${col}"] input`);
  el?.focus();
}

function onKeydown(e: KeyboardEvent, row: number, col: number, picker: boolean) {
  if (e.ctrlKey && e.key === 'Insert') {
    e.preventDefault();
    e.stopPropagation();
    state.lines.splice(row, 0, blankJournalLine());
    void focus(row, col);
    return;
  }
  if (e.ctrlKey && e.key === 'Delete') {
    e.preventDefault();
    e.stopPropagation();
    removeLine(row);
    return;
  }
  if (picker) return;
  if (e.key === 'Enter' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (row + 1 >= state.lines.length) state.lines.push(blankJournalLine());
    void focus(row + 1, col);
  } else if (e.key === 'ArrowUp' && row > 0) {
    e.preventDefault();
    void focus(row - 1, col);
  }
}

function removeLine(i: number) {
  state.lines.splice(i, 1);
  if (state.lines.length === 0) state.lines.push(blankJournalLine());
}

const totals = computed<TotalRow[]>(() => [
  { label: 'Total debits', value: fmtMoney(balance.value.debits) },
  { label: 'Total credits', value: fmtMoney(balance.value.credits) },
  {
    label: 'Out of balance',
    value: fmtMoney(
      balance.value.difference < 0n ? -balance.value.difference : balance.value.difference,
    ),
    strong: true,
  },
]);

async function save(next: 'stay' | 'new' = 'stay') {
  if (busy.value) return;
  issues.value = [];
  let body: Record<string, unknown>;
  try {
    body = mode.value === 'add' ? journalAddBody(state) : journalModBody(state);
  } catch (err) {
    issues.value = [err instanceof Error ? err.message : String(err)];
    return;
  }
  const result = await cmd.run(
    'JournalEntry',
    body,
    mode.value === 'mod' ? state.TxnID : undefined,
    {
      label: `${mode.value === 'add' ? 'New' : 'Edit'} journal entry ${state.RefNumber}`.trim(),
      base: original.value,
      formObject: 'JournalEntryMod',
    },
  );
  if (!result || cmd.phase.value !== 'confirmed') return;
  toast.add({
    severity: 'success',
    summary: 'Saved',
    detail: 'Journal entry recorded in QuickBooks.',
    life: 3000,
  });
  if (next === 'new') {
    if (mode.value === 'add') fresh();
    else await router.push('/transactions/journal-entry/new');
    return;
  }
  const id = cmd.createdId() ?? state.TxnID;
  if (mode.value === 'add' && id) {
    cmd.hold();
    await router.replace(`/transactions/journal-entry/${encodeURIComponent(id)}`);
  } else if (id) {
    try {
      loadInto((await getObject('JournalEntry', id)).data);
    } catch {
      // keep the form as is
    }
  }
}

function reapply() {
  const cur = cmd.current();
  if (cur && typeof cur.EditSequence === 'string') state.EditSequence = cur.EditSequence;
  if (cur) original.value = cur;
  cmd.reset();
  void save();
}

function discard() {
  const cur = cmd.current();
  cmd.reset();
  if (cur) loadInto(cur);
  else void load();
}

function close() {
  if (window.history.length > 1) router.back();
  else void router.push('/');
}

useHotkeys({ save: () => void save('stay'), saveNew: () => void save('new') });
</script>

<template>
  <FormFrame
    title="Make General Journal Entries"
    :subtitle="mode === 'mod' && state.RefNumber ? `#${state.RefNumber}` : undefined"
    :mode="mode"
    :busy="busy"
    :blocked="!balance.balanced"
    @save="save('stay')"
    @save-new="save('new')"
    @revert="mode === 'mod' && original ? loadInto(original) : fresh()"
    @close="close"
  >
    <template #status>
      <Message v-if="loadError" severity="error" :closable="false"
        >Could not load the entry: {{ loadError }}</Message
      >
      <CommandBanner
        :phase="cmd.phase.value"
        :command="cmd.command.value"
        :error="cmd.error.value"
        :issues="issues"
        subject="the journal entry"
        @reapply="reapply"
        @discard="discard"
        @dismiss="cmd.reset()"
      />
    </template>
    <template #header>
      <Skeleton v-if="loading" height="3rem" />
      <div v-else class="je-hdr">
        <label class="je-f">
          <span>Date</span>
          <input v-model="state.TxnDate" type="date" class="je-in" />
        </label>
        <label class="je-f">
          <span>Entry no.</span>
          <input v-model="state.RefNumber" class="je-in" maxlength="11" />
        </label>
        <label class="je-check">
          <input
            type="checkbox"
            :checked="state.IsAdjustment === true"
            @change="state.IsAdjustment = ($event.target as HTMLInputElement).checked"
          />
          <span>Adjusting entry</span>
        </label>
      </div>
    </template>
    <template #lines>
      <div class="je-wrap">
        <table ref="table" class="je" aria-label="Journal lines">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col" style="width: 16rem">Account</th>
              <th scope="col" class="num" style="width: 8rem">Debit</th>
              <th scope="col" class="num" style="width: 8rem">Credit</th>
              <th scope="col">Memo</th>
              <th scope="col" style="width: 12rem">Name</th>
              <th scope="col" style="width: 9rem">Class</th>
              <th scope="col" style="width: 8rem">Billable</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(l, i) in state.lines"
              :key="l.key"
              :class="{ bad: balance.invalidLines.includes(i) }"
            >
              <td class="n">{{ i + 1 }}</td>
              <td :data-cell="`r${i}c0`" @keydown="onKeydown($event, i, 0, true)">
                <RefPicker
                  :model-value="l.AccountRef"
                  source="Account"
                  :aria-label="`Line ${i + 1} account`"
                  placeholder=" "
                  compact
                  @update:model-value="onAccount(i, $event)"
                />
              </td>
              <td :data-cell="`r${i}c1`" @keydown="onKeydown($event, i, 1, false)">
                <input
                  class="cell num"
                  inputmode="decimal"
                  :aria-label="`Line ${i + 1} debit`"
                  :value="l.debit"
                  @input="setAmount(l, 'debit', ($event.target as HTMLInputElement).value)"
                  @blur="l.debit && (l.debit = normAmount(l.debit) || l.debit)"
                />
              </td>
              <td :data-cell="`r${i}c2`" @keydown="onKeydown($event, i, 2, false)">
                <input
                  class="cell num"
                  inputmode="decimal"
                  :aria-label="`Line ${i + 1} credit`"
                  :value="l.credit"
                  @input="setAmount(l, 'credit', ($event.target as HTMLInputElement).value)"
                  @blur="l.credit && (l.credit = normAmount(l.credit) || l.credit)"
                />
              </td>
              <td :data-cell="`r${i}c3`" @keydown="onKeydown($event, i, 3, false)">
                <input
                  v-model="l.Memo"
                  class="cell"
                  maxlength="4095"
                  :aria-label="`Line ${i + 1} memo`"
                />
              </td>
              <td @keydown="onKeydown($event, i, 4, true)">
                <RefPicker
                  v-model="l.EntityRef"
                  source="Entity"
                  :aria-label="`Line ${i + 1} name`"
                  placeholder=" "
                  compact
                />
              </td>
              <td @keydown="onKeydown($event, i, 5, true)">
                <RefPicker
                  v-model="l.ClassRef"
                  source="Class"
                  :aria-label="`Line ${i + 1} class`"
                  placeholder=" "
                  compact
                />
              </td>
              <td>
                <select
                  v-model="l.BillableStatus"
                  class="cell"
                  :aria-label="`Line ${i + 1} billable`"
                >
                  <option :value="undefined" />
                  <option v-for="b in BILLABLE" :key="b" :value="b">{{ b }}</option>
                </select>
              </td>
              <td>
                <button
                  v-if="!isBlankJournalLine(l)"
                  type="button"
                  class="del"
                  :aria-label="`Delete line ${i + 1}`"
                  @click="removeLine(i)"
                >
                  <i class="pi pi-times" aria-hidden="true" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <template #footer>
      <label v-if="mode === 'add'" class="je-f je-memo">
        <span>Memo</span>
        <textarea v-model="state.Memo" class="je-in" rows="2" />
      </label>
      <Message
        v-if="!balance.balanced && balance.debits + balance.credits > 0n"
        severity="warn"
        :closable="false"
      >
        Debits and credits must be equal before the entry can be saved.
      </Message>
    </template>
    <template #totals>
      <TotalsPanel :rows="totals" />
    </template>
  </FormFrame>
</template>

<style scoped>
.je-hdr {
  display: flex;
  gap: 1rem;
  align-items: end;
  flex-wrap: wrap;
}
.je-f {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.je-memo {
  max-width: 40rem;
}
.je-in {
  font: inherit;
  font-size: 0.95rem;
  color: var(--p-text-color);
  padding: 0.3rem 0.45rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
}
.je-check {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  padding-bottom: 0.4rem;
}
.je-wrap {
  overflow-x: auto;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
}
.je {
  width: 100%;
  border-collapse: collapse;
}
.je th {
  text-align: left;
  font-size: 0.75rem;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
  background: var(--p-content-hover-background);
  padding: 0.35rem 0.4rem;
}
.je td {
  padding: 1px 2px;
  border-bottom: 1px solid var(--p-content-border-color);
}
.je .n {
  text-align: right;
  color: var(--p-text-muted-color);
  width: 2rem;
}
.je .bad td {
  background: color-mix(in srgb, var(--p-red-500) 10%, transparent);
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
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
