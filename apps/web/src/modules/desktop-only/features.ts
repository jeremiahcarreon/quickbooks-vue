import type { NavArea } from '../types';

/**
 * QuickBooks Desktop features the qbXML SDK does not expose. They get a nav
 * entry that explains where to do them instead of silently missing (DESIGN §1).
 */
export interface DesktopOnlyFeature {
  slug: string;
  title: string;
  area: NavArea;
  icon: string;
  /** Why it cannot be done here. */
  why: string;
  /** Where to do it in QuickBooks Desktop. */
  where: string;
  /** What this app does offer that is related. */
  instead?: { label: string; to: string }[];
}

export const DESKTOP_ONLY: DesktopOnlyFeature[] = [
  {
    slug: 'reconcile',
    title: 'Reconcile',
    area: 'Banking',
    icon: 'pi pi-check-circle',
    why: 'The QuickBooks SDK cannot start, complete or undo a bank or credit card reconciliation.',
    where: 'Banking > Reconcile in QuickBooks Desktop.',
    instead: [
      {
        label: 'Mark single transactions cleared (Cleared status on a check or deposit)',
        to: '/objects/Check',
      },
    ],
  },
  {
    slug: 'bank-feeds',
    title: 'Bank feeds',
    area: 'Banking',
    icon: 'pi pi-globe',
    why: 'Downloading and matching bank or credit card transactions is not part of the SDK.',
    where: 'Banking > Bank Feeds in QuickBooks Desktop.',
  },
  {
    slug: 'payroll',
    title: 'Run payroll',
    area: 'Employees',
    icon: 'pi pi-wallet',
    why: 'Creating paychecks, payroll tax calculations, tax forms and direct deposit are not available through the SDK; paychecks and payroll items can only be read.',
    where: 'Employees > Pay Employees and Employees > Payroll Center in QuickBooks Desktop.',
    instead: [
      { label: 'Paychecks', to: '/objects/Paycheck' },
      { label: 'Payroll liability checks', to: '/objects/PayrollLiabilityCheck' },
    ],
  },
  {
    slug: 'closing-date',
    title: 'Closing date',
    area: 'Company',
    icon: 'pi pi-lock',
    why: 'The closing date and its password cannot be read or set through the SDK. QuickBooks still enforces it: writes dated on or before it fail with a QuickBooks error.',
    where:
      'Edit > Preferences > Accounting > Company Preferences > Set Date/Password in QuickBooks Desktop.',
  },
  {
    slug: 'qb-users',
    title: 'QuickBooks users',
    area: 'Company',
    icon: 'pi pi-id-card',
    why: 'QuickBooks Desktop users, roles and passwords are not exposed by the SDK. Access to this app is managed separately under Admin > Users.',
    where: 'Company > Users > Set Up Users and Roles in QuickBooks Desktop.',
    instead: [{ label: 'Users of this app', to: '/admin/users' }],
  },
  {
    slug: 'form-templates',
    title: 'Form templates',
    area: 'Company',
    icon: 'pi pi-palette',
    why: 'Templates can be listed and chosen on a transaction, but designing or editing their layout is not possible through the SDK.',
    where: 'Lists > Templates in QuickBooks Desktop.',
    instead: [{ label: 'Templates (read only)', to: '/objects/Template' }],
  },
  {
    slug: 'preferences',
    title: 'Edit preferences',
    area: 'Company',
    icon: 'pi pi-sliders-h',
    why: 'Company preferences can be read through the SDK but almost none of them can be changed.',
    where: 'Edit > Preferences in QuickBooks Desktop.',
    instead: [{ label: 'Preferences (read only)', to: '/objects/Preferences' }],
  },
];

export function desktopOnlyFeature(slug: string): DesktopOnlyFeature | undefined {
  return DESKTOP_ONLY.find((f) => f.slug === slug);
}
