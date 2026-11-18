/** Errors rendered as `{ error: { code, message, details? } }`. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'unauthorized') =>
  new HttpError(401, code, message);
export const forbidden = (message: string, code = 'forbidden', details?: unknown) =>
  new HttpError(403, code, message, details);
export const notFound = (message: string, code = 'not_found', details?: unknown) =>
  new HttpError(404, code, message, details);
export const conflict = (message: string, code = 'conflict', details?: unknown) =>
  new HttpError(409, code, message, details);

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } };
}
