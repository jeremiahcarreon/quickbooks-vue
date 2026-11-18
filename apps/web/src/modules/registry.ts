import type { RouteRecordRaw } from 'vue-router';
import { NAV_AREAS, type NavArea, type NavItem, type WebModule } from './types';

export interface RegisteredModule extends Required<WebModule> {
  name: string;
}

type ModuleExports = Partial<WebModule> & { default?: WebModule };

/** Turn import.meta.glob results into registered modules, sorted by name. */
export function collectModules(found: Record<string, unknown>): RegisteredModule[] {
  return Object.entries(found)
    .map(([path, mod]) => {
      const m = (mod ?? {}) as ModuleExports;
      const src: WebModule = m.default ?? m;
      const name = /\/([^/]+)\/index\.ts$/.exec(path)?.[1] ?? path;
      return { name, routes: src.routes ?? [], nav: src.nav ?? [] };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function allRoutes(mods: RegisteredModule[]): RouteRecordRaw[] {
  return mods.flatMap((m) => m.routes);
}

export interface NavGroup {
  area: NavArea;
  items: NavItem[];
}

/** Nav items grouped by area in NAV_AREAS order, filtered by permission. */
export function navGroups(
  mods: RegisteredModule[],
  can: (permission: string) => boolean = () => true,
): NavGroup[] {
  const items = mods.flatMap((m) => m.nav).filter((n) => !n.permission || can(n.permission));
  return NAV_AREAS.map((area) => ({
    area,
    items: items
      .filter((i) => i.area === area)
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label)),
  })).filter((g) => g.items.length > 0);
}

/** Every feature module: src/modules/<name>/index.ts exporting { routes, nav }. */
export const modules: RegisteredModule[] = collectModules(
  import.meta.glob('./*/index.ts', { eager: true }),
);
