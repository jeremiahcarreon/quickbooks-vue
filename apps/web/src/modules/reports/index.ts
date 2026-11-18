import type { NavItem, WebModule } from '../types';

export const routes: NonNullable<WebModule['routes']> = [
  {
    path: '/reports',
    name: 'reports',
    component: () => import('./views/ReportCatalogView.vue'),
    meta: { title: 'Reports' },
  },
  {
    path: '/reports/:name',
    name: 'report-run',
    component: () => import('./views/ReportRunView.vue'),
    props: true,
    meta: { title: 'Report' },
  },
];

const quick = (label: string, name: string, order: number): NavItem => ({
  label,
  to: `/reports/${name}`,
  area: 'Reports',
  icon: 'pi pi-file',
  order,
  permission: `report:${name}`,
});

export const nav: NavItem[] = [
  { label: 'All Reports', to: '/reports', area: 'Reports', icon: 'pi pi-chart-bar', order: 1 },
  quick('Profit & Loss', 'GeneralSummary.ProfitAndLossStandard', 10),
  quick('Balance Sheet', 'GeneralSummary.BalanceSheetStandard', 11),
  quick('A/R Aging', 'ar-aging-summary', 20),
  quick('A/P Aging', 'ap-aging-summary', 21),
  quick('Open Invoices', 'open-invoices', 22),
];

export default { routes, nav } satisfies WebModule;
