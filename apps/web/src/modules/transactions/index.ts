/**
 * Purpose-built transaction forms (QuickBooks Desktop-style): sales, purchases,
 * banking and journal entries. Registered through the module registry.
 */
import type { RouteRecordRaw } from 'vue-router';
import type { NavItem } from '../types';
import { SPECIAL_FORMS, SPECS } from './lib/specs';

const TxnFormView = () => import('./views/TxnFormView.vue');

export const routes: RouteRecordRaw[] = [
  {
    path: '/transactions',
    name: 'transactions',
    component: () => import('./views/TransactionsHub.vue'),
    meta: { title: 'Transactions' },
  },
  {
    path: '/transactions/receive-payment/:id',
    name: 'txn-receive-payment',
    component: () => import('./views/ReceivePaymentView.vue'),
    props: true,
    meta: { title: 'Receive Payment' },
  },
  {
    path: '/transactions/pay-bills',
    alias: '/transactions/pay-bills/new',
    name: 'txn-pay-bills',
    component: () => import('./views/PayBillsView.vue'),
    meta: { title: 'Pay Bills' },
  },
  {
    path: '/transactions/journal-entry/:id',
    name: 'txn-journal-entry',
    component: () => import('./views/JournalEntryView.vue'),
    props: true,
    meta: { title: 'Journal Entry' },
  },
  {
    path: '/transactions/deposit/:id',
    name: 'txn-deposit',
    component: () => import('./views/DepositView.vue'),
    props: true,
    meta: { title: 'Make Deposits' },
  },
  {
    path: '/transactions/:slug/:id',
    name: 'txn-form',
    component: TxnFormView,
    props: true,
  },
];

const forms = [
  ...SPECS.map((s) => ({
    slug: s.slug,
    type: s.type,
    label: s.label,
    area: s.area,
    icon: s.icon,
    order: s.order,
  })),
  ...SPECIAL_FORMS,
];

export const nav: NavItem[] = forms.map((f) => ({
  label: f.label,
  to: f.slug === 'pay-bills' ? '/transactions/pay-bills' : `/transactions/${f.slug}/new`,
  area: f.area,
  icon: f.icon,
  order: f.order,
  permission: `object:${f.type}:write`,
}));
