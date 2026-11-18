export interface RelayErrorInit {
  status?: number;
  body?: string;
  /** Safe to retry later (relay/QuickBooks unavailable). */
  retryable?: boolean;
  /** QuickBooks may have processed the request even though no answer came back. */
  mayHaveExecuted?: boolean;
  cause?: unknown;
}

/** Base class for every relay failure. */
export class RelayError extends Error {
  readonly status?: number;
  readonly body?: string;
  readonly retryable: boolean;
  readonly mayHaveExecuted: boolean;
  constructor(message: string, init: RelayErrorInit = {}) {
    super(message, { cause: init.cause });
    this.name = 'RelayError';
    this.status = init.status;
    this.body = init.body;
    this.retryable = init.retryable ?? false;
    this.mayHaveExecuted = init.mayHaveExecuted ?? false;
  }
}

/** 400: malformed request body (e.g. missing qbxml). */
export class RelayBadRequestError extends RelayError {
  constructor(message: string, init: RelayErrorInit = {}) {
    super(message, { ...init, status: 400 });
    this.name = 'RelayBadRequestError';
  }
}
/** 401: wrong or missing X-Api-Key. */
export class RelayAuthError extends RelayError {
  constructor(message: string, init: RelayErrorInit = {}) {
    super(message, { ...init, status: 401 });
    this.name = 'RelayAuthError';
  }
}
/** 403: caller IP not in the relay allowlist. */
export class RelayForbiddenError extends RelayError {
  constructor(message: string, init: RelayErrorInit = {}) {
    super(message, { ...init, status: 403 });
    this.name = 'RelayForbiddenError';
  }
}
/** 404: unknown route. */
export class RelayNotFoundError extends RelayError {
  constructor(message: string, init: RelayErrorInit = {}) {
    super(message, { ...init, status: 404 });
    this.name = 'RelayNotFoundError';
  }
}
/** 502: the COM call to QuickBooks failed. QuickBooks may have done part of the work. */
export class RelayQbError extends RelayError {
  constructor(message: string, init: RelayErrorInit = {}) {
    super(message, { mayHaveExecuted: true, ...init, status: init.status ?? 502 });
    this.name = 'RelayQbError';
  }
}
/** 503: QuickBooks not connected. Nothing was sent; retry later. */
export class RelayUnavailableError extends RelayError {
  constructor(message: string, init: RelayErrorInit = {}) {
    super(message, { ...init, status: 503, retryable: true, mayHaveExecuted: false });
    this.name = 'RelayUnavailableError';
  }
}
/** 504 from the relay, or the client-side timeout. The request may have run. */
export class RelayTimeoutError extends RelayError {
  constructor(message: string, init: RelayErrorInit = {}) {
    super(message, { ...init, retryable: true, mayHaveExecuted: true });
    this.name = 'RelayTimeoutError';
  }
}
/** Could not reach the relay (DNS, refused, reset). */
export class RelayNetworkError extends RelayError {
  constructor(message: string, init: RelayErrorInit = {}) {
    super(message, { retryable: true, ...init });
    this.name = 'RelayNetworkError';
  }
}
/** The relay answered with something that does not follow the contract. */
export class RelayProtocolError extends RelayError {
  constructor(message: string, init: RelayErrorInit = {}) {
    super(message, init);
    this.name = 'RelayProtocolError';
  }
}
/** The qbXML failed XSD validation; it was not sent. */
export class RelayValidationError extends RelayError {
  readonly errors: { line: number; message: string }[];
  constructor(errors: { line: number; message: string }[]) {
    super(
      `qbXML failed XSD validation, not sent: ${errors
        .map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message))
        .join('; ')}`,
    );
    this.name = 'RelayValidationError';
    this.errors = errors;
  }
}
