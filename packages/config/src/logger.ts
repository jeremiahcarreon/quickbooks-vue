import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

/** Paths never written to logs. */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'password_hash',
  '*.password_hash',
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
  'RELAY_API_KEY',
  'SESSION_SECRET',
  'ADMIN_PASSWORD',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',
];

export interface CreateLoggerOptions {
  /** Service name, written as `service` on every line. */
  service: string;
  level?: LoggerOptions['level'];
  /** Human-readable output via pino-pretty (development only). */
  pretty?: boolean;
  /** Extra fields bound to every line. */
  base?: Record<string, unknown>;
  /** Write to this destination instead of stdout (tests). */
  destination?: DestinationStream;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level: opts.level ?? 'info',
    base: { service: opts.service, ...opts.base },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
  if (opts.destination) return pino(options, opts.destination);
  if (opts.pretty) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
      },
    });
  }
  return pino(options);
}

/** Convenience: build a logger from a loaded service config. */
export function loggerFromConfig(
  service: string,
  config: { LOG_LEVEL: string; LOG_PRETTY: boolean },
): Logger {
  return createLogger({ service, level: config.LOG_LEVEL, pretty: config.LOG_PRETTY });
}
