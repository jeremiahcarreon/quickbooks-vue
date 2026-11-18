import { todayIso } from './dates.js';
import { coerceParams, ReportError, type RawParams } from './params.js';
import { qbReportDefinitions, type QbReportDefinition } from './qb/definitions.js';
import { runQbReport, type QbReportDeps, type ReportOutcome, type RunQbOptions } from './qb/run.js';
import { activityReports } from './sql/activity.js';
import { agingReports } from './sql/aging.js';
import { balanceReports } from './sql/balances.js';
import type { SqlReportDefinition } from './sql/common.js';
import type { ReportDefinitionInfo, ReportParams, ReportResult } from './types.js';

export type ReportDefinition = SqlReportDefinition | QbReportDefinition;

/** SQL operational reports over qb_object. */
export const sqlReports: readonly SqlReportDefinition[] = [
  ...agingReports,
  ...balanceReports,
  ...activityReports,
];

let all: Map<string, ReportDefinition> | undefined;

function registry(): Map<string, ReportDefinition> {
  if (!all) {
    all = new Map();
    for (const d of [...sqlReports, ...qbReportDefinitions()]) {
      if (all.has(d.name)) throw new Error(`Duplicate report name ${d.name}`);
      all.set(d.name, d);
    }
  }
  return all;
}

export function listReports(): ReportDefinition[] {
  return [...registry().values()];
}

export function getReport(name: string): ReportDefinition | undefined {
  return registry().get(name);
}

/** The serialisable part of a definition (no run function). */
export function describeReport(def: ReportDefinition): ReportDefinitionInfo {
  const info: ReportDefinitionInfo = {
    name: def.name,
    title: def.title,
    description: def.description,
    category: def.category,
    source: def.source,
    params: def.params,
  };
  if (def.source === 'qb') info.qb = def.qb;
  return info;
}

/** Permission needed to run a report (`report:*` also grants it). */
export const reportPermission = (name: string): string => `report:${name}`;

export type ReportDeps = QbReportDeps;

export async function runSqlReport(
  deps: Pick<ReportDeps, 'db' | 'now'>,
  def: SqlReportDefinition,
  params: ReportParams,
): Promise<ReportResult> {
  const now = deps.now?.() ?? new Date();
  const out = await def.run(deps.db, params, { today: todayIso(now) });
  const { subtitle, notes, ...rest } = out;
  return {
    ...rest,
    meta: {
      name: def.name,
      title: def.title,
      ...(subtitle ? { subtitle } : {}),
      source: 'sql',
      params: params as Record<string, unknown>,
      generatedAt: now.toISOString(),
      rowCount: out.rows.filter((r) => r.kind === 'data').length,
      ...(notes && notes.length ? { notes } : {}),
    },
  };
}

/** Validate params and run any report by name. */
export async function runReport(
  deps: ReportDeps,
  name: string,
  raw: RawParams,
  opts: RunQbOptions = {},
): Promise<ReportOutcome> {
  const def = getReport(name);
  if (!def) throw new ReportError(404, 'not_found', `Unknown report ${name}`);
  const params = coerceParams(def.params, raw);
  if (def.source === 'sql')
    return { status: 'ready', result: await runSqlReport(deps, def, params) };
  return runQbReport(deps, def, params, opts);
}
