import type { QbvEvent } from '@qbv/queue';

/** The part of @qbv/relay-client's RelayClient the worker uses. */
export interface RelayLike {
  request(qbxml: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string>;
  ping(): Promise<{ ok: boolean; connected: boolean; latencyMs?: number; error?: string }>;
}

/** Anything that can publish to the qbv:events channel (an EventBus). */
export interface EventPublisher {
  publish(event: QbvEvent): Promise<void>;
}

export interface ValidationResultLike {
  valid: boolean;
  errors: { line: number; column?: number; message: string; path?: string }[];
}
export type Validator = (xml: string) => ValidationResultLike;

/** Minimal structured logger (pino-compatible). */
export interface Logger {
  debug(obj: object | string, msg?: string): void;
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
