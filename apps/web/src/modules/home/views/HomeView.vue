<script setup lang="ts">
/**
 * Home dashboard: receivables and payables at a glance, recent activity,
 * shortcuts to the daily forms, and the health of the QuickBooks link.
 */
import Button from 'primevue/button';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { api, ApiError } from '@/api/client';
import { typeLabel } from '../../centers/lib/centers';
import { getHealth, type HealthView } from '../../transactions/lib/api';
import { todayIso } from '../../transactions/lib/calc';
import { dec, fmtMoney } from '../../transactions/lib/decimal';
import {
  AGING_BUCKETS,
  loadOpen,
  loadRecent,
  type OpenSummary,
  type RecentTxn,
} from '../lib/dashboard';
import { summarizeSync, type SyncSummary } from '../lib/sync';

const router = useRouter();
const ar = ref<OpenSummary | null>(null);
const ap = ref<OpenSummary | null>(null);
const recent = ref<RecentTxn[]>([]);
const health = ref<HealthView | null>(null);
const healthError = ref<string | null>(null);
const sync = ref<SyncSummary | null>(null);
const errors = ref<string[]>([]);
const loading = ref(false);
const updated = ref<Date | null>(null);

async function refresh() {
  loading.value = true;
  errors.value = [];
  const today = todayIso();
  const tasks: Promise<void>[] = [
    loadOpen('Invoice', today)
      .then((v) => void (ar.value = v))
      .catch((e: unknown) => void errors.value.push(`Invoices: ${(e as Error).message}`)),
    loadOpen('Bill', today)
      .then((v) => void (ap.value = v))
      .catch((e: unknown) => void errors.value.push(`Bills: ${(e as Error).message}`)),
    loadRecent()
      .then((v) => void (recent.value = v))
      .catch(() => undefined),
    getHealth()
      .then((h) => {
        health.value = h;
        healthError.value = null;
      })
      .catch((e: unknown) => {
        health.value = null;
        healthError.value = (e as Error).message;
      }),
    api
      .get('/admin/sync')
      .then((raw) => void (sync.value = summarizeSync(raw)))
      .catch((e: unknown) => {
        // Only administrators can see sync detail.
        if (!(e instanceof ApiError && (e.status === 403 || e.status === 404))) sync.value = null;
      }),
  ];
  await Promise.all(tasks);
  updated.value = new Date();
  loading.value = false;
}

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), 60_000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const relayOk = computed(() => health.value?.parts.relay?.ok ?? health.value?.parts.quickbooks?.ok);

const shortcuts = [
  { label: 'Invoice', to: '/transactions/invoice/new', icon: 'pi pi-file' },
  { label: 'Receive payment', to: '/transactions/receive-payment/new', icon: 'pi pi-wallet' },
  { label: 'Sales receipt', to: '/transactions/sales-receipt/new', icon: 'pi pi-receipt' },
  { label: 'Enter bill', to: '/transactions/bill/new', icon: 'pi pi-file-edit' },
  { label: 'Pay bills', to: '/transactions/pay-bills', icon: 'pi pi-money-bill' },
  { label: 'Write check', to: '/transactions/check/new', icon: 'pi pi-pencil' },
  { label: 'Deposit', to: '/transactions/deposit/new', icon: 'pi pi-building-columns' },
  { label: 'Journal entry', to: '/transactions/journal-entry/new', icon: 'pi pi-book' },
  { label: 'Customer Center', to: '/centers/customers', icon: 'pi pi-users' },
  { label: 'Vendor Center', to: '/centers/vendors', icon: 'pi pi-truck' },
];
</script>

<template>
  <section class="home">
    <header class="home__head">
      <h1>Home</h1>
      <div class="home__meta">
        <span v-if="updated" class="muted">Updated {{ updated.toLocaleTimeString() }}</span>
        <Button
          size="small"
          text
          icon="pi pi-refresh"
          label="Refresh"
          :loading="loading"
          @click="refresh"
        />
      </div>
    </header>

    <Message v-for="e in errors" :key="e" severity="warn" :closable="false">{{ e }}</Message>

    <div class="tiles">
      <RouterLink to="/centers/customers" class="tile">
        <span class="tile__label">Open invoices</span>
        <span class="tile__value">{{ ar ? fmtMoney(ar.total) : '...' }}</span>
        <span class="tile__sub"
          >{{ ar ? `${ar.count} open` : ''
          }}<template v-if="ar?.truncated"> (partial)</template></span
        >
      </RouterLink>
      <RouterLink
        to="/centers/customers"
        class="tile"
        :class="{ 'tile--warn': ar && ar.overdue > 0n }"
      >
        <span class="tile__label">Overdue</span>
        <span class="tile__value">{{ ar ? fmtMoney(ar.overdue) : '...' }}</span>
        <span class="tile__sub">{{
          ar ? `${ar.overdueCount} invoice${ar.overdueCount === 1 ? '' : 's'}` : ''
        }}</span>
      </RouterLink>
      <RouterLink to="/transactions/pay-bills" class="tile">
        <span class="tile__label">Unpaid bills</span>
        <span class="tile__value">{{ ap ? fmtMoney(ap.total) : '...' }}</span>
        <span class="tile__sub">{{
          ap ? `${ap.count} open, ${ap.overdueCount} overdue` : ''
        }}</span>
      </RouterLink>
      <div class="tile" :class="{ 'tile--warn': relayOk === false || healthError }">
        <span class="tile__label">QuickBooks link</span>
        <span class="tile__value tile__value--sm">
          <Tag v-if="healthError" severity="danger" value="API unreachable" />
          <Tag v-else-if="relayOk === undefined" severity="secondary" value="Unknown" />
          <Tag
            v-else
            :severity="relayOk ? 'success' : 'danger'"
            :value="relayOk ? 'Connected' : 'Relay down'"
          />
        </span>
        <span class="tile__sub">
          <template v-if="health">
            <span v-for="(p, name) in health.parts" :key="name" class="part" :title="p.detail">
              <i
                :class="p.ok ? 'pi pi-check-circle ok' : 'pi pi-times-circle bad'"
                aria-hidden="true"
              />{{ name }}
            </span>
          </template>
        </span>
      </div>
    </div>

    <div class="cols">
      <div class="panel">
        <h2>Aging</h2>
        <table class="t" aria-label="Aging">
          <thead>
            <tr>
              <th scope="col">Days past due</th>
              <th scope="col" class="num">Receivables</th>
              <th scope="col" class="num">Payables</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in AGING_BUCKETS" :key="b">
              <td>{{ b }}</td>
              <td class="num">{{ ar ? fmtMoney(ar.aging[b]) : '' }}</td>
              <td class="num">{{ ap ? fmtMoney(ap.aging[b]) : '' }}</td>
            </tr>
          </tbody>
        </table>
        <h2 class="mt">Sync</h2>
        <p v-if="!sync" class="muted">Sync detail is available to administrators.</p>
        <dl v-else class="facts">
          <dt>Object types</dt>
          <dd>{{ sync.types }}</dd>
          <dt>Last run</dt>
          <dd>{{ sync.lastRun ? new Date(sync.lastRun).toLocaleString() : 'never' }}</dd>
          <dt>Running</dt>
          <dd>{{ sync.running }}</dd>
          <dt>Errors</dt>
          <dd>
            <Tag
              v-if="sync.errors.length"
              severity="danger"
              :value="`${sync.errors.length}`"
              :title="sync.errors.join(', ')"
            />
            <span v-else>none</span>
          </dd>
        </dl>
      </div>

      <div class="panel">
        <h2>Recent transactions</h2>
        <table class="t" aria-label="Recent transactions">
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Num</th>
              <th scope="col">Date</th>
              <th scope="col">Name</th>
              <th scope="col" class="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!recent.length">
              <td colspan="5" class="muted">No recent activity.</td>
            </tr>
            <tr
              v-for="t in recent"
              :key="`${t.type}-${t.id}`"
              :class="{ link: !!t.path }"
              :tabindex="t.path ? 0 : undefined"
              @click="t.path && router.push(t.path)"
              @keydown.enter="t.path && router.push(t.path)"
            >
              <td>{{ typeLabel(t.type) }}</td>
              <td>{{ t.number }}</td>
              <td>{{ t.date }}</td>
              <td>{{ t.name }}</td>
              <td class="num">{{ fmtMoney(dec(t.amount)) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="panel">
        <h2>Do</h2>
        <nav class="shortcuts" aria-label="Shortcuts">
          <RouterLink v-for="s in shortcuts" :key="s.to" :to="s.to" class="shortcut">
            <i :class="s.icon" aria-hidden="true" /> {{ s.label }}
          </RouterLink>
        </nav>
      </div>
    </div>
  </section>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 90rem;
}
.home__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.home__head h1 {
  margin: 0;
  font-size: 1.4rem;
}
.home__meta {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: 0.75rem;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
  color: var(--p-text-color);
  text-decoration: none;
}
a.tile:hover,
a.tile:focus-visible {
  border-color: var(--p-primary-color);
}
.tile--warn {
  border-left: 4px solid var(--p-orange-500);
}
.tile__label {
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color);
}
.tile__value {
  font-size: 1.6rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.tile__value--sm {
  font-size: 1rem;
}
.tile__sub {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.part i {
  margin-right: 0.2rem;
}
.ok {
  color: var(--p-green-500);
}
.bad {
  color: var(--p-red-500);
}
.cols {
  display: grid;
  grid-template-columns: minmax(16rem, 1fr) minmax(24rem, 2fr) minmax(12rem, 1fr);
  gap: 0.75rem;
  align-items: start;
}
.panel {
  padding: 0.75rem 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
}
.panel h2 {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
}
.mt {
  margin-top: 1rem !important;
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
  padding: 0.25rem 0.4rem;
  border-bottom: 1px solid var(--p-content-border-color);
}
.t td {
  padding: 0.3rem 0.4rem;
  border-bottom: 1px solid var(--p-content-border-color);
}
.t tr.link {
  cursor: pointer;
}
.t tr.link:hover td,
.t tr.link:focus td {
  background: var(--p-content-hover-background);
}
.num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
}
.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.2rem 0.75rem;
  margin: 0;
}
.facts dt {
  color: var(--p-text-muted-color);
}
.facts dd {
  margin: 0;
}
.shortcuts {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.shortcut {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  padding: 0.35rem 0.4rem;
  border-radius: var(--p-content-border-radius);
  color: var(--p-text-color);
  text-decoration: none;
}
.shortcut:hover,
.shortcut:focus-visible {
  background: var(--p-content-hover-background);
}
.muted {
  color: var(--p-text-muted-color);
}
@media (max-width: 1100px) {
  .cols {
    grid-template-columns: 1fr;
  }
}
</style>
