# QuickBooks Vue

A relay and web dashboard for QuickBooks Desktop. Any application can read and write a QuickBooks Desktop company file over plain HTTP, and people can browse it from a browser.

QuickBooks Desktop only talks to programs on the same Windows machine, through a COM API. QuickBooks Vue runs on that machine as a small service and opens it up safely:

```
Your app (any language)  ──HTTP/JSON──►  QuickBooks Vue  ──COM──►  QuickBooks Desktop
Your browser             ──dashboard──►    (Windows)
```

It came out of a production ERP integration that pushes invoices, payments and credit memos to QuickBooks Enterprise every day, so it handles the awkward parts: sharing the company file with people using QuickBooks at the same time, QuickBooks dialogs that hang a request, and malformed qbXML that would otherwise drop the session.

## What's here

| Folder | What it is | Status |
|---|---|---|
| [`server/`](server/) | The relay: a .NET 8 Windows service with an HTTP API in front of the QuickBooks SDK | Working, in production use |
| `web/` | Vue 3 + TypeScript dashboard, served by the relay | Planned |
| `python/` | Python client and a read-only MCP server for AI assistants | Planned |

## Quick start

See [`server/README.md`](server/README.md) to install the relay, then:

```bash
curl -H "X-Api-Key: your-key" -H "Content-Type: application/json" \
  -d '{"qbxml": "<?xml version=\"1.0\"?><?qbxml version=\"16.0\"?><QBXML><QBXMLMsgsRq onError=\"stopOnError\"><CustomerQueryRq><MaxReturned>5</MaxReturned></CustomerQueryRq></QBXMLMsgsRq></QBXML>"}' \
  http://your-qb-machine:9123/qb/request
```

## Requirements

- Windows 10/11 or Windows Server 2016+
- QuickBooks Desktop (Pro, Premier or Enterprise) with the QuickBooks SDK installed

QuickBooks is a trademark of Intuit Inc. This project is not affiliated with or endorsed by Intuit.

## License

[MIT](LICENSE)
