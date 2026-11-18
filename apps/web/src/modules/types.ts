import type { RouteRecordRaw } from 'vue-router';

/** Sidebar areas, in display order (DESIGN section 7). */
export const NAV_AREAS = [
  'Home',
  'Customers',
  'Vendors',
  'Employees',
  'Banking',
  'Company',
  'Lists',
  'Reports',
  'Admin',
] as const;
export type NavArea = (typeof NAV_AREAS)[number];

export interface NavItem {
  label: string;
  /** Route path or named location. */
  to: string;
  area: NavArea;
  /** PrimeIcons class, e.g. `pi pi-users`. */
  icon?: string;
  /** Lower sorts first within the area (default 100). */
  order?: number;
  /** Permission required to see the item, e.g. `object:Invoice:read`. */
  permission?: string;
}

/**
 * What `src/modules/<name>/index.ts` exports. Either named exports
 * (`export const routes = [...]; export const nav = [...]`) or a default
 * export of this shape.
 */
export interface WebModule {
  routes?: RouteRecordRaw[];
  nav?: NavItem[];
}
