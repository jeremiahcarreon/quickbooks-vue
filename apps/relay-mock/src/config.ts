import {
  commonEnv,
  parseEnv,
  qbxmlEnv,
  relayMockEnv,
  zBool,
  zDuration,
  zInt,
  zList,
} from '@qbv/config';
import { z } from 'zod';

/** Environment of the relay mock (see README). */
export const mockEnvSchema = commonEnv
  .merge(qbxmlEnv)
  .merge(relayMockEnv)
  .extend({
    /** Extra client IPs allowed besides loopback; empty = no IP check (like the relay). */
    MOCK_ALLOWED_IPS: zList(),
    /** Simulated QuickBooks processing time per request. */
    MOCK_LATENCY_MS: zInt(0, { min: 0 }),
    MOCK_LATENCY_JITTER_MS: zInt(0, { min: 0 }),
    /** Relay-side timeout used by the timeout fault (the real relay uses 120s). */
    MOCK_REQUEST_TIMEOUT_MS: zDuration('120s'),
    /** Load the sample HVAC company when the store is empty. */
    SEED: zBool(false),
    /** Last day of the generated sample transactions: YYYY-MM-DD or "today". */
    MOCK_SEED_ANCHOR: z
      .string()
      .regex(/^(\d{4}-\d{2}-\d{2}|today)$/, 'must be YYYY-MM-DD or "today"')
      .default('2026-10-31'),
    /** Persist the company file to this JSON file (loaded at start, saved after writes). */
    MOCK_DATA_FILE: z.string().min(1).optional(),
    MOCK_COMPANY_NAME: z.string().min(1).default('Summit Air Heating & Cooling'),
  });

export type MockConfig = z.output<typeof mockEnvSchema>;

export function loadMockConfig(env: Record<string, string | undefined> = process.env): MockConfig {
  return parseEnv(mockEnvSchema, env, 'relay-mock');
}
