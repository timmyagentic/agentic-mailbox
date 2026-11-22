# Operational diagnostics

Agentic Mailbox uses the existing Cloudflare Workers Logs store. There is no second database of logs, browser analytics service, or polling loop. The checked-in `observability.enabled` setting already enables Workers Logs; installing these code changes in production remains a separate deployment action.

## Finding an operation

Every API response includes `X-Request-Id`. Error responses also include `error.requestId`, and the admin UI displays it with the error message. Search that ID in the Worker's **Observability → Logs** page. If the browser cannot reach the Worker, the UI shows a network error without inventing a server request ID. After a failed write, refresh to confirm its outcome before submitting it again.

For new events during a debugging session, use the installed Wrangler CLI:

```bash
npx wrangler tail agentic-mailbox --format json
```

Tail is a live stream, not a way to retrieve earlier activity. Historical queries require access to Workers Observability; ordinary Wrangler deployment access does not necessarily grant that permission. Retention and sampling depend on the Cloudflare account configuration. Do not infer that an event never happened merely because its log is unavailable.

## Event fields

All application records include `timestamp`, `level`, and `event`.

| Event | Meaning and useful fields |
| --- | --- |
| `http_request` | API completion or static request failure: generated `requestId`, route template, method, status, optional application error code, `durationMs`. Includes expected 4xx failures and returned health-check 503 responses. |
| `email_rejected` | Recipient has an unmanaged domain or is not an active managed alias. Includes reason, `processingId`, and duration. |
| `email_duplicate` | An existing Message-ID for the same alias was skipped. Includes internal alias ID and `processingId`; no external Message-ID. |
| `email_ingested` | Mail and attachments are stored. Includes internal email/alias IDs, attachment count, raw size, duration, and forwarding outcome (`disabled`, `succeeded`, or `failed`). |
| `email_ingest_failed` | Ingestion failed at `recipient`, `alias_lookup`, `parse`, `deduplicate`, `attachments`, `database`, or `forward`. The handler still throws, preserving platform failure/retry semantics. |
| `forward_failed` | Mail was stored but optional forwarding failed. Correlate using internal email ID and `processingId`; this does not mean the stored mail was lost. |
| `attachment_cleanup_failed` | An attempt to remove uploaded objects after a storage failure also failed. Correlate with the ingestion failure by `processingId`. |

## Privacy boundary

Application logs contain only operational metadata. They do not include passwords, session tokens, cookies, request/response bodies, query strings, literal resource paths, email addresses, subjects, external Message-IDs, message text, verification codes, attachment names, or raw exception text. HTTP request IDs are generated locally instead of trusting an incoming header. Unhandled ingestion exceptions are replaced with a generic error containing the processing ID, so provider/MIME errors do not leak into automatic exception logs.

Cloudflare's own invocation records are separate and may include request URLs and other platform metadata. This change does not alter the account's logging settings or retention. Review that separate platform configuration before sharing raw log exports. Share only the relevant operation's safe fields for troubleshooting.

## Verification

`npm run check` runs ESLint, TypeScript, Vitest, the production asset build, and `wrangler deploy --dry-run`. The final step validates the bundle without publishing it. Regression tests cover request correlation, sensitive-data omission, recipient rejection, duplicate skips, forwarding/parse/storage/cleanup failures, recent-message navigation, late dialog responses, and visible login/session/network errors.
