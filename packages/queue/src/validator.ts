/** Result shape of @qbv/qbxml `validate()`. */
export interface XsdValidationResult {
  valid: boolean;
  errors: { line: number; column?: number; message: string; path?: string }[];
}
export type QbxmlValidator = (xml: string) => XsdValidationResult;

/** Thrown when a qbXML document fails XSD validation; nothing was queued or sent. */
export class QbxmlRejectedError extends Error {
  readonly errors: XsdValidationResult['errors'];
  constructor(errors: XsdValidationResult['errors']) {
    super(
      `qbXML failed XSD validation: ${errors
        .map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message))
        .join('; ')}`,
    );
    this.name = 'QbxmlRejectedError';
    this.errors = errors;
  }
}

let cached: Promise<QbxmlValidator> | undefined;

/**
 * The XSD validator from @qbv/qbxml (libxml2 against schemas/qbxml/17.0 or
 * QBXML_SCHEMA_DIR). Loaded lazily so this package builds independently.
 */
export function defaultValidator(): Promise<QbxmlValidator> {
  cached ??= (async () => {
    const spec = '@qbv/qbxml';
    const mod = (await import(spec)) as { validate: QbxmlValidator };
    if (typeof mod.validate !== 'function')
      throw new Error('@qbv/qbxml does not export validate()');
    return mod.validate;
  })();
  return cached;
}

/** Validate or throw QbxmlRejectedError. */
export async function assertValidQbxml(xml: string, validator?: QbxmlValidator): Promise<void> {
  const v = validator ?? (await defaultValidator());
  const r = v(xml);
  if (!r.valid)
    throw new QbxmlRejectedError(r.errors.length ? r.errors : [{ line: 0, message: 'invalid' }]);
}
