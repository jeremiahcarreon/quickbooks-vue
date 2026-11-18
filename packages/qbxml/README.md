# @qbv/qbxml

qbXML core for QuickBooks Vue: loads the Intuit qbXML 17.0 XSDs, validates
documents with libxml2 (`libxml2-wasm`), generates a catalog of every request,
response and object from the schema, builds schema-ordered requests and parses
responses. **Every document `buildRequest`/`buildBatch`/`buildResponse` returns
has already passed XSD validation.**

## Setup

The XSDs are Intuit-confidential and not in git. Copy `QBUqbxmlops170.xsd`,
`QBUqbxml170.xsd`, `QBUqbxmlso170.xsd` and `qbxmltypes170.xsd` from the
QuickBooks SDK into `schemas/qbxml/17.0/` (or point `QBXML_SCHEMA_DIR` at them).

```sh
npm run codegen -w @qbv/qbxml   # writes generated/catalog.json and generated/types.ts
npm run build -w @qbv/qbxml     # runs codegen first if the XSDs changed
npm test -w @qbv/qbxml
```

`npm install` runs codegen automatically when the XSDs are present (and skips
with a notice when they are not). `generated/` is gitignored; never commit it.

| Env var            | Default                     | Purpose                                      |
| ------------------ | --------------------------- | -------------------------------------------- |
| `QBXML_SCHEMA_DIR` | `<repo>/schemas/qbxml/17.0` | Directory holding the four XSDs              |
| `QBXML_VERSION`    | `16.0`                      | `<?qbxml version?>` header on built requests |

## API

```ts
import {
  loadSchema,
  validate,
  catalog,
  buildRequest,
  buildBatch,
  buildResponse,
  parseResponse,
  isOk,
  idOf,
  editSequenceOf,
  toNumber,
  toBool,
  toDate,
  formatAmount,
  QbxmlValidationError,
  QbxmlBuildError,
} from '@qbv/qbxml';
```

### Schema and validation

- `loadSchema(dir?): Promise<QbSchema>` compiles the XSD (entry
  `QBUqbxmlops170.xsd`, includes resolved in memory) and caches it. Passing a
  directory makes that schema the active one. `loadSchemaSync` is the sync form.
- `validate(xml): { valid, errors: { line, column?, message, path? }[] }`
  validates against the active schema (loading the default on first use).
  Malformed XML is reported as errors, never thrown.
- Request documents (root holding `QBXMLMsgsRq` / `QBXMLSubscriptionMsgsRq`)
  must also carry exactly one `<?qbxml version="N.N"?>` processing instruction
  before `<QBXML>`, with a version QuickBooks has shipped (`QBXML_VERSIONS`,
  1.0 to 17.0). The XSD cannot express this, so `validate()` checks it too and
  reports a missing, repeated or unknown version as an error. Responses are
  not checked. `checkEnvelope(xml, { maxVersion })` additionally rejects a
  version newer than a configured maximum; `qbxmlVersionOf(xml)` reads it.
- `assertValid(xml)` throws `QbxmlValidationError` (`.errors`, `.xml`).
- Missing XSDs fail with a message naming the files and `QBXML_SCHEMA_DIR`.

### Catalog (`generated/catalog.json`)

`catalog.requests`, `catalog.objects`, `catalog.entities` (plus
`catalog.messageSets`), typed by `RequestDef`, `ObjectDef`, `FieldDef`,
`EntityDef` exactly as in docs/DESIGN.md §6.1, with these additions:

- `FieldDef.choiceBranch` / `choicePath` (branch index, nested choice path),
  `minInclusive`/`maxInclusive`, `default`, `attributes` (simpleContent, e.g. `useMacro`).
  Fields are flattened (groups inlined) in sequence order. `minOccurs` is the
  element's own count times its enclosing sequences; a field in a choice is
  only required when its branch is chosen.
- `ObjectDef.attributes` (e.g. `requestID`, `iterator` on Rq types, `rowNumber` on report rows).
- `RequestDef.retElements` (union queries such as `ItemQueryRq` return several
  Ret kinds; `retElement` is set only when there is exactly one),
  `supportsMetaData`, `msgSet` (`QBXMLMsgsRq` or `QBXMLSubscriptionMsgsRq`).
- `EntityDef.modifiedFilter` (`FromModifiedDate` for lists,
  `ModifiedDateRangeFilter` for transactions), `supportsIterator`,
  `unionQuery` (e.g. `PayrollItemTax` has no own query; use `PayrollItemQueryRq`),
  `voidType`, `hasEditSequence`, `keyFields`.
- Entities: every `XRet` returned by an Add/Mod/Query request, except
  `ReportRet`, `ListDeletedRet`, `TxnDeletedRet`, `TransactionRet`.
  `category` is `list` (ListID), `txn` (TxnID) or `other`. `ops.del` is
  `ListDelRq`/`TxnDelRq` when the entity is in the `ListDelType`/`TxnDelType`
  enum (`delType` holds the value); `ops.void` is `TxnVoidRq`.

TypeScript interfaces for every object are exported as the `QbTypes`
namespace (`QbTypes.CustomerAdd`, `QbTypes.InvoiceRet`, `QbTypes.RequestName`,
`QbTypes.EntityName`, `QbTypes.RequestBodies`, ...).

### Building

```ts
buildRequest(
  'InvoiceAddRq',
  {
    InvoiceAdd: {
      CustomerRef: { FullName: 'Acme' },
      TxnDate: '2024-01-15',
      InvoiceLineAdd: [{ ItemRef: { FullName: 'Consulting' }, Quantity: 10, Rate: 150 }],
    },
  },
  { requestID: '1' },
);

buildRequest('CustomerAddRq', { Name: 'Acme' }); // bare body: wrapped in CustomerAdd
buildRequest(
  'CustomerQueryRq',
  { FromModifiedDate: since, MaxReturned: 500 },
  { iterator: 'Start' },
);
buildBatch([{ rq: 'HostQueryRq' }, { rq: 'CompanyQueryRq' }], 'continueOnError');
```

- `body` is the content of the Rq element (`{ CustomerAdd: {...}, IncludeRetElement: [...] }`).
  For Add/Mod requests a bare object (`{ Name: 'Acme' }`) is wrapped in the body element.
- Keys are reordered into schema order. Unknown fields or attributes throw
  `QbxmlBuildError` (a subclass of `QbxmlValidationError`) with a "did you mean" hint.
- Values: strings are written as given. Numbers, booleans and `Date`s are
  formatted for the field's base type (`AMTTYPE` → two decimals,
  `PRICETYPE`/`QUANTYPE`/`PERCENTTYPE` → up to five, `DATETYPE` → UTC date,
  `DATETIMETYPE` → local time with offset). `null`/`undefined` are skipped.
  Repeated fields take arrays. Attributes: `'@name'` keys; simple values with
  attributes: `{ '#text': '1-1', '@useMacro': 'TxnID:x' }`.
- Options: `requestID`, `onError` (default `stopOnError`), `version`
  (default `QBXML_VERSION || '16.0'`), `iterator`, `iteratorID`, `metaData`.
  `buildBatch` gives parts without a requestID their index (`"0"`, `"1"`, ...).
- The document is validated; failures throw `QbxmlValidationError` with libxml2 errors and line numbers.
- In a repeating choice (e.g. `InvoiceLineAdd` | `InvoiceLineGroupAdd`) all
  elements of the first kind are written before the second; order _within_ each kind is kept.
- `buildResponse([{ rs, body, statusCode, statusMessage, requestID, iteratorID, iteratorRemainingCount }])`
  builds a validated QuickBooks-style response (for the relay mock and tests).

### Parsing

`parseResponse(xml): ParsedRs[]`, one per response element:
`{ name, requestID, statusCode, statusSeverity, statusMessage, rets, retName, retNames, retCount, iteratorID, iteratorRemainingCount, body, raw }`.
Element names are keys; elements with `maxOccurs > 1` in the schema are always
arrays (one invoice line is still an array); leaf values stay strings
(entities decoded); attributes appear as `'@name'`. `isOk(rs)` is true for
status 0 and non-error codes below 1000. Garbage input throws `QbxmlParseError`.

### Helpers

`toNumber`, `toBool`, `toDate`, `toDateTime`; `formatAmount`, `formatPrice`,
`formatQuantity`, `formatPercent`, `formatInt`, `formatBool`, `formatDate`,
`formatDateTime`, `formatValue(type, v)`, `formatMoney` (display);
`idOf(entity, ret)`, `editSequenceOf(ret)`, `nameOf(ret)`, `refId(ref)`,
`entityOfRet(retName)`, `queryableEntities()`; `minimalObject(name)` /
`minimalRequestBody(rq)` / `sampleValue(field)` produce schema-valid sample data.
