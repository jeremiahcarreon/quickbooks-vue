<script setup lang="ts">
/**
 * Spec-driven transaction form (invoice, sales receipt, estimate, sales order,
 * credit memo, statement charge, bill, check, purchase order, item receipt,
 * vendor credit, credit card charge/credit, transfer).
 */
import Message from 'primevue/message';
import Skeleton from 'primevue/skeleton';
import { useToast } from 'primevue/usetoast';
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import CommandBanner from '../components/CommandBanner.vue';
import FieldInput from '../components/FieldInput.vue';
import FormFrame from '../components/FormFrame.vue';
import LineGrid from '../components/LineGrid.vue';
import TotalsPanel from '../components/TotalsPanel.vue';
import { getEntityMeta, getObject, hydrateRef, type MetaDefs } from '../lib/api';
import {
  applyPricingEdit,
  blankLine,
  dueDateFromTerms,
  headerAmount,
  purchaseTotals,
  salesTotals,
  todayIso,
} from '../lib/calc';
import { dec, fmt, fmtMoney, parseDec } from '../lib/decimal';
import { diffFields, type DiffRow } from '../lib/diff';
import { buildBody, checkForm, stateFromRet, type FormIssue } from '../lib/payload';
import { refIn } from '../lib/refs';
import { specBySlug } from '../lib/specs';
import type { HeaderField, RefValue, TotalRow, TxnFormState, TxnSpec } from '../lib/types';
import { useCommand } from '../lib/useCommand';
import { useHotkeys } from '../lib/useHotkeys';

const props = defineProps<{ slug: string; id: string }>();
const route = useRoute();
const router = useRouter();
const toast = useToast();

const spec = computed<TxnSpec | undefined>(() => specBySlug(props.slug));
const mode = computed<'add' | 'mod'>(() => (props.id === 'new' ? 'add' : 'mod'));

const state = reactive<TxnFormState>({ header: {}, lines: {} });
const original = shallowRef<Record<string, unknown> | null>(null);
const defs = shallowRef<MetaDefs>(new Map());
const loading = ref(false);
const loadError = ref<string | null>(null);
const readOnlyReason = ref<string | undefined>();
const issues = ref<FormIssue[]>([]);
const dueTouched = ref(false);
const diff = ref<DiffRow[]>([]);
const cmd = useCommand();
const grids = ref<InstanceType<typeof LineGrid>[]>([]);

const busy = computed(() => cmd.phase.value === 'submitting' || cmd.phase.value === 'pending');
const objName = computed(() =>
  mode.value === 'add' ? spec.value?.addObject : (spec.value?.modObject ?? spec.value?.addObject),
);

function fieldsIn(slot: HeaderField['slot']) {
  return (spec.value?.header ?? []).filter((f) => (f.slot ?? 'main') === slot);
}

function metaField(obj: string | undefined, name: string) {
  return obj ? defs.value.get(obj)?.fields.find((f) => f.name === name) : undefined;
}

function maxLengthOf(f: HeaderField) {
  return metaField(objName.value, f.name)?.maxLength ?? f.maxLength;
}

function fieldIssue(name: string) {
  return issues.value.some((i) => i.field === name && i.section === undefined);
}

function freshState(): void {
  const s = spec.value;
  state.TxnID = undefined;
  state.EditSequence = undefined;
  state.header = { TxnDate: todayIso() };
  state.lines = Object.fromEntries((s?.lines ?? []).map((sec) => [sec.key, [blankLine()]]));
  state.loadedSections = [];
  original.value = null;
  readOnlyReason.value = undefined;
  issues.value = [];
  dueTouched.value = false;
  diff.value = [];
}

function loadInto(ret: Record<string, unknown>) {
  const s = spec.value!;
  const loaded = stateFromRet(s, ret);
  state.TxnID = loaded.state.TxnID;
  state.EditSequence = loaded.state.EditSequence;
  state.header = loaded.state.header;
  state.lines = loaded.state.lines;
  state.loadedSections = loaded.state.loadedSections;
  readOnlyReason.value = loaded.readOnlyReason;
  original.value = ret;
  dueTouched.value = true;
  issues.value = [];
  diff.value = [];
  void hydrateHeader();
}

async function hydrateHeader() {
  for (const f of spec.value?.header ?? []) {
    if (f.kind !== 'ref' || !f.ref) continue;
    if (!['TermsRef', 'ItemSalesTaxRef'].includes(f.name)) continue;
    const v = state.header[f.name] as RefValue | null | undefined;
    if (v && !v.data) {
      const h = await hydrateRef(f.ref, v);
      if (h && state.header[f.name] === v) state.header[f.name] = h;
    }
  }
}

async function load() {
  const s = spec.value;
  loadError.value = null;
  if (!s) return;
  void getEntityMeta(s.type).then((d) => (defs.value = d));
  if (mode.value === 'add') {
    freshState();
    await prefillEntity();
    return;
  }
  loading.value = true;
  try {
    const row = await getObject(s.type, props.id);
    loadInto(row.data);
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

/** ?entity=<ListID> (from the customer/vendor centers) preselects the customer/vendor/payee. */
async function prefillEntity() {
  const s = spec.value;
  const id = typeof route.query.entity === 'string' ? route.query.entity : null;
  if (!s?.entityField || !id) return;
  const types =
    s.entityKind === 'customer'
      ? ['Customer']
      : s.entityKind === 'vendor'
        ? ['Vendor']
        : ['Vendor', 'Customer', 'Employee', 'OtherName'];
  for (const t of types) {
    try {
      const row = await getObject(t, id);
      const data = row.data;
      const r: RefValue = {
        ListID: typeof data.ListID === 'string' ? data.ListID : row.id,
        FullName:
          (data.FullName as string | undefined) ?? (data.Name as string | undefined) ?? row.name,
        type: t,
        data,
      };
      setHeader(s.entityField, r);
      return;
    } catch {
      // try the next type
    }
  }
}

watch(
  () => [props.slug, props.id],
  () => {
    cmd.resetOnNavigate();
    void load();
  },
  { immediate: true },
);

/** Copy the defaults QuickBooks fills in when a customer/vendor/payee is chosen. */
function applyEntityDefaults(entity: RefValue | null) {
  const s = spec.value;
  const d = entity?.data;
  if (!s || !d || mode.value !== 'add') return;
  const has = (name: string) => s.header.some((f) => f.name === name);
  const copy = (target: string, ...sources: string[]) => {
    if (!has(target)) return;
    for (const src of sources) {
      const v = d[src];
      if (v && typeof v === 'object') {
        state.header[target] = Array.isArray(v)
          ? v[0]
          : target.endsWith('Ref')
            ? refIn(v)
            : { ...(v as object) };
        return;
      }
    }
  };
  if (s.entityKind === 'customer') {
    copy('BillAddress', 'BillAddress');
    copy('ShipAddress', 'ShipAddress', 'BillAddress');
    copy('TermsRef', 'TermsRef');
    copy('SalesRepRef', 'SalesRepRef');
    copy('ItemSalesTaxRef', 'ItemSalesTaxRef');
  } else if (s.entityKind === 'vendor') {
    copy('VendorAddress', 'VendorAddress');
    copy('TermsRef', 'TermsRef');
  } else {
    copy('Address', 'VendorAddress', 'BillAddress', 'EmployeeAddress');
  }
  void hydrateHeader().then(updateDueDate);
}

function updateDueDate() {
  const s = spec.value;
  if (!s?.dueDateField || dueTouched.value) return;
  const due = dueDateFromTerms(state.header.TermsRef, String(state.header.TxnDate ?? ''));
  if (due) state.header[s.dueDateField] = due;
}

function setHeader(name: string, value: unknown) {
  const s = spec.value;
  if (!s) return;
  const hp = s.headerPricing;
  if (hp && (name === hp.qty || name === hp.rate || name === hp.amount)) {
    const res = applyPricingEdit(hp, { ...state.header, [name]: value }, name);
    state.header = { ...res.values, __lastEdited: res.lastEdited ?? state.header.__lastEdited };
    return;
  }
  state.header[name] = value;
  if (name === s.entityField) applyEntityDefaults(value as RefValue | null);
  if (name === s.dueDateField) dueTouched.value = true;
  if (name === 'TermsRef' || name === 'TxnDate') {
    void hydrateHeader().then(updateDueDate);
  }
  if (name === 'ItemSalesTaxRef') void hydrateHeader();
}

function onHeaderPicked(f: HeaderField, v: RefValue) {
  // Statement charge: picking the item fills description and rate.
  const s = spec.value;
  if (!s?.headerPricing || f.name !== 'ItemRef') return;
  const d = v.data ?? {};
  const sap = (d.SalesAndPurchase ?? {}) as Record<string, unknown>;
  const sop = (d.SalesOrPurchase ?? {}) as Record<string, unknown>;
  const desc = d.SalesDesc ?? sap.SalesDesc ?? sop.Desc;
  const price = d.SalesPrice ?? sap.SalesPrice ?? sop.Price;
  if (typeof desc === 'string') state.header.Desc = desc;
  if (typeof price === 'string') setHeader(s.headerPricing.rate, price);
}

// ---------------------------------------------------------------------------
// Totals

const totals = computed<TotalRow[]>(() => {
  const s = spec.value;
  if (!s) return [];
  const rows: TotalRow[] = [];
  if (s.totals === 'sales' && s.lines[0]) {
    const t = salesTotals(
      s.lines[0],
      state.lines[s.lines[0].key] ?? [],
      state.header.ItemSalesTaxRef,
    );
    const rate = (state.header.ItemSalesTaxRef as RefValue | undefined)?.data?.TaxRate;
    rows.push({ label: 'Subtotal', value: fmtMoney(t.subtotal) });
    rows.push({
      label: typeof rate === 'string' ? `Tax (${fmt(dec(rate), 5, 0)}%)` : 'Tax',
      value: t.tax === null ? 'by QuickBooks' : fmtMoney(t.tax),
      hint:
        t.tax === null
          ? 'The tax rate is not known here; QuickBooks will calculate the tax.'
          : undefined,
    });
    rows.push({ label: s.totalLabel, value: fmtMoney(t.total), strong: true });
  } else if (s.totals === 'purchase') {
    const t = purchaseTotals(s.lines, state.lines);
    if (s.lines.length > 1) {
      for (const sec of s.lines)
        rows.push({ label: sec.label, value: fmtMoney(t.bySection[sec.key] ?? 0n) });
    }
    rows.push({ label: s.totalLabel, value: fmtMoney(t.total), strong: true });
  } else if (s.totals === 'header-amount') {
    const amt = s.headerPricing
      ? headerAmount(
          s.headerPricing,
          state.header,
          state.header.__lastEdited as 'rate' | 'amount' | undefined,
        )
      : (parseDec(state.header.Amount) ?? 0n);
    rows.push({ label: s.totalLabel, value: fmtMoney(amt), strong: true });
  }
  const o = original.value;
  if (o && mode.value === 'mod') {
    const qb =
      o.TotalAmount ??
      o.Amount ??
      o.AmountDue ??
      (o.Subtotal !== undefined ? fmt(dec(o.Subtotal) + dec(o.SalesTaxTotal)) : undefined);
    if (qb !== undefined)
      rows.push({
        label: 'In QuickBooks',
        value: fmtMoney(dec(qb)),
        hint: 'Last figure recorded by QuickBooks',
      });
    if (o.BalanceRemaining !== undefined)
      rows.push({ label: 'Balance due', value: fmtMoney(dec(o.BalanceRemaining)) });
    if (o.OpenAmount !== undefined)
      rows.push({ label: 'Open balance', value: fmtMoney(dec(o.OpenAmount)) });
  }
  return rows;
});

const invalidLines = (key: string) =>
  issues.value.filter((i) => i.section === key).map((i) => i.line!);
const formIssues = computed(() => issues.value.map((i) => i.message));

// ---------------------------------------------------------------------------
// Save

const subject = computed(() => {
  const s = spec.value;
  const ref = state.header.RefNumber;
  return s ? `${s.label}${typeof ref === 'string' && ref ? ` ${ref}` : ''}` : '';
});

async function save(next: 'stay' | 'new' | 'close' = 'stay') {
  const s = spec.value;
  if (!s || busy.value || readOnlyReason.value) return;
  issues.value = checkForm(s, state, mode.value, defs.value);
  if (issues.value.length) return;
  let body: Record<string, unknown>;
  try {
    body = buildBody(s, state, mode.value, defs.value);
  } catch (err) {
    issues.value = [{ field: '', message: err instanceof Error ? err.message : String(err) }];
    return;
  }
  const result = await cmd.run(s.type, body, mode.value === 'mod' ? state.TxnID : undefined, {
    label: `${mode.value === 'add' ? 'New' : 'Edit'} ${subject.value}`,
    base: original.value,
    formObject: s.modObject ?? undefined,
  });
  if (!result) return;
  if (cmd.phase.value === 'conflict') {
    const cur = cmd.current();
    diff.value = cur ? diffFields(s.header, state.header, stateFromRet(s, cur).state.header) : [];
    return;
  }
  if (cmd.phase.value !== 'confirmed') return;
  toast.add({
    severity: 'success',
    summary: 'Saved',
    detail: `${subject.value} recorded in QuickBooks.`,
    life: 3000,
  });
  if (next === 'new') {
    if (mode.value === 'add') freshState();
    else await router.push(`/transactions/${s.slug}/new`);
    return;
  }
  if (next === 'close') {
    close();
    return;
  }
  const newId = cmd.createdId();
  if (mode.value === 'add' && newId) {
    cmd.hold();
    await router.replace(`/transactions/${s.slug}/${encodeURIComponent(newId)}`);
  } else if (mode.value === 'mod' && state.TxnID) {
    try {
      const row = await getObject(s.type, state.TxnID);
      loadInto(row.data);
    } catch {
      // keep the form; the confirmed banner already shows success
    }
  }
}

/** Conflict: take QuickBooks' EditSequence and keep the user's edits, then save again. */
function reapply() {
  const cur = cmd.current();
  if (!cur) return;
  state.EditSequence = typeof cur.EditSequence === 'string' ? cur.EditSequence : state.EditSequence;
  original.value = cur;
  diff.value = [];
  cmd.reset();
  void save();
}

function discard() {
  const cur = cmd.current();
  cmd.reset();
  if (cur) loadInto(cur);
  else void load();
}

function revert() {
  cmd.reset();
  if (mode.value === 'mod' && original.value) loadInto(original.value);
  else freshState();
}

function close() {
  if (window.history.length > 1) router.back();
  else void router.push('/');
}

useHotkeys({
  save: () => void save('stay'),
  saveNew: () => void save('new'),
  insertLine: () => grids.value.some((g) => g?.insertAtFocus()),
  deleteLine: () => grids.value.some((g) => g?.deleteAtFocus()),
});
</script>

<template>
  <div v-if="!spec" class="missing">
    <Message severity="warn" :closable="false">Unknown transaction form "{{ slug }}".</Message>
  </div>
  <FormFrame
    v-else
    :title="spec.label"
    :subtitle="mode === 'mod' && state.header.RefNumber ? `#${state.header.RefNumber}` : undefined"
    :mode="mode"
    :busy="busy"
    :read-only="!!readOnlyReason"
    @save="save('stay')"
    @save-new="save('new')"
    @revert="revert"
    @close="close"
  >
    <template #status>
      <Message v-if="loadError" severity="error" :closable="false"
        >Could not load the transaction: {{ loadError }}</Message
      >
      <Message v-if="readOnlyReason" severity="warn" :closable="false">{{
        readOnlyReason
      }}</Message>
      <CommandBanner
        :phase="cmd.phase.value"
        :command="cmd.command.value"
        :error="cmd.error.value"
        :issues="formIssues"
        :diff="diff"
        :subject="subject"
        @reapply="reapply"
        @discard="discard"
        @dismiss="cmd.reset()"
      />
    </template>

    <template #header>
      <div v-if="loading" class="hdr"><Skeleton height="6rem" /></div>
      <div v-else class="hdr">
        <div class="hdr__main">
          <FieldInput
            v-for="f in fieldsIn('main')"
            :key="f.name"
            :class="{
              hdr__wide: f.kind === 'ref' && f.name === spec.entityField,
              hdr__full: f.kind === 'textarea',
            }"
            :field="f"
            :model-value="state.header[f.name]"
            :input-id="`h-${f.name}`"
            :max-length="maxLengthOf(f)"
            :options="metaField(objName, f.name)?.enum"
            :invalid="fieldIssue(f.name)"
            :disabled="!!readOnlyReason"
            @update:model-value="setHeader(f.name, $event)"
            @picked="onHeaderPicked(f, $event)"
          />
        </div>
        <div v-if="fieldsIn('address').length" class="hdr__addr">
          <FieldInput
            v-for="f in fieldsIn('address')"
            :key="f.name"
            :field="f"
            :model-value="state.header[f.name]"
            :input-id="`h-${f.name}`"
            :disabled="!!readOnlyReason"
            @update:model-value="setHeader(f.name, $event)"
          />
        </div>
        <div v-if="fieldsIn('detail').length" class="hdr__detail">
          <FieldInput
            v-for="f in fieldsIn('detail')"
            :key="f.name"
            :class="{ hdr__full: f.kind === 'textarea' }"
            :field="f"
            :model-value="state.header[f.name]"
            :input-id="`h-${f.name}`"
            :max-length="maxLengthOf(f)"
            :options="metaField(objName, f.name)?.enum"
            :invalid="fieldIssue(f.name)"
            :disabled="!!readOnlyReason"
            @update:model-value="setHeader(f.name, $event)"
            @picked="onHeaderPicked(f, $event)"
          />
        </div>
      </div>
    </template>

    <template #lines>
      <section v-for="sec in spec.lines" :key="sec.key" class="sec">
        <h2 v-if="spec.lines.length > 1" class="sec__title">{{ sec.label }}</h2>
        <LineGrid
          ref="grids"
          :lines="state.lines[sec.key] ?? []"
          :section="sec"
          :line-object="mode === 'add' ? sec.add : sec.mod"
          :defs="defs"
          :readonly="!!readOnlyReason"
          :invalid-lines="invalidLines(sec.key)"
          @update:lines="state.lines[sec.key] = $event"
        />
      </section>
    </template>

    <template #footer>
      <div class="ftr">
        <FieldInput
          v-for="f in fieldsIn('footer')"
          :key="f.name"
          :class="{ hdr__full: f.kind === 'textarea' }"
          :field="f"
          :model-value="state.header[f.name]"
          :input-id="`h-${f.name}`"
          :max-length="maxLengthOf(f)"
          :invalid="fieldIssue(f.name)"
          :disabled="!!readOnlyReason"
          @update:model-value="setHeader(f.name, $event)"
        />
      </div>
    </template>

    <template #totals>
      <TotalsPanel :rows="totals" />
    </template>
  </FormFrame>
</template>

<style scoped>
.hdr {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.hdr__main,
.hdr__detail,
.ftr {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
  gap: 0.5rem 0.75rem;
  align-items: end;
}
.hdr__addr {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 22rem));
  gap: 0.75rem;
}
.hdr__wide {
  grid-column: span 2;
}
.hdr__full {
  grid-column: 1 / -1;
}
.sec__title {
  margin: 0 0 0.25rem;
  font-size: 0.95rem;
  font-weight: 600;
}
.sec + .sec {
  margin-top: 0.75rem;
}
</style>
