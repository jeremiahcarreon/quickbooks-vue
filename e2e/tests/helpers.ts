import { readFileSync } from 'node:fs';
import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL, RELAY_API_KEY, RELAY_MOCK_URL, RUN_INFO, STORAGE_STATE } from './env.js';

export interface QbObject {
  type: string;
  id: string;
  editSequence: string | null;
  name: string | null;
  refNumber: string | null;
  amount: string | null;
  isActive: boolean | null;
  deletedAt: string | null;
  data: Record<string, unknown>;
}

export interface CommandView {
  id: string;
  status: string;
  objectId: string | null;
  statusCode: number | null;
  statusMessage: string | null;
  result: Record<string, unknown> | null;
}

/**
 * API client logged in as the admin (cookie session from global setup), with
 * the CSRF header every cookie-authenticated write needs.
 */
export class Api {
  private constructor(
    readonly ctx: APIRequestContext,
    private readonly csrf: string,
  ) {}

  static async create(): Promise<Api> {
    const state = JSON.parse(readFileSync(STORAGE_STATE, 'utf8')) as {
      cookies: { name: string; value: string }[];
    };
    const csrf = state.cookies.find((c) => c.name === 'qbv_csrf')?.value ?? '';
    const ctx = await request.newContext({ baseURL: BASE_URL, storageState: STORAGE_STATE });
    return new Api(ctx, csrf);
  }

  get headers(): Record<string, string> {
    return { 'x-csrf-token': this.csrf };
  }

  async list(
    type: string,
    query: Record<string, string> = {},
  ): Promise<{ items: QbObject[]; total: number }> {
    const res = await this.ctx.get(`/api/objects/${type}`, { params: query });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as { items: QbObject[]; total: number };
  }

  async get(type: string, id: string): Promise<QbObject | null> {
    const res = await this.ctx.get(`/api/objects/${type}/${encodeURIComponent(id)}`, {
      params: { includeDeleted: 'true' },
    });
    if (res.status() === 404) return null;
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as QbObject;
  }

  /** Add through the API and wait for QuickBooks; returns the new object's id. */
  async add(type: string, body: Record<string, unknown>): Promise<CommandView> {
    const res = await this.ctx.post(`/api/objects/${type}?wait=true`, {
      data: body,
      headers: this.headers,
    });
    expect(res.status(), await res.text()).toBe(200);
    const json = (await res.json()) as { command: CommandView };
    expect(json.command.status).toBe('succeeded');
    return json.command;
  }

  async mod(type: string, id: string, body: Record<string, unknown>): Promise<CommandView> {
    const res = await this.ctx.patch(`/api/objects/${type}/${encodeURIComponent(id)}?wait=true`, {
      data: body,
      headers: this.headers,
    });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as { command: CommandView }).command;
  }

  async findByName(type: string, name: string): Promise<QbObject | undefined> {
    const { items } = await this.list(type, { 'filter[name]': name, pageSize: '5' });
    return items.find((o) => o.name === name);
  }

  async dispose(): Promise<void> {
    await this.ctx.dispose();
  }
}

/** Relay mock control and inspection (dev stack only). */
export async function relayMock(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: RELAY_MOCK_URL,
    extraHTTPHeaders: { 'x-api-key': RELAY_API_KEY },
  });
}

export function runStartedAt(): Date {
  const info = JSON.parse(readFileSync(RUN_INFO, 'utf8')) as { startedAt: string };
  return new Date(info.startedAt);
}

/** Pick an option from a PrimeVue AutoComplete by typing and choosing the matching row. */
export async function pickRef(
  page: Page,
  input: ReturnType<Page['locator']>,
  text: string,
  option = text,
) {
  await input.click();
  await input.fill(text);
  const opt = page.locator('.p-autocomplete-overlay [role=option]', { hasText: option }).first();
  await expect(opt).toBeVisible();
  await opt.click();
}
