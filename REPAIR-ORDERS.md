# Repair orders — local/simulated increment, 16 October 2026

Current update: this document records the initial RO increment. The broader
check-in/workshop/collection, recovery, activity mirroring and handover workflows
are now implemented. Their current status and limitations are documented in
[LOCAL-SCOPE-REVIEW.md](LOCAL-SCOPE-REVIEW.md). New RO workflow mutations use
`POST /api/service/repair-orders/:id/actions/:action` with an Idempotency-Key and
current version; collection never changes invoice/payment fields. The earlier
remaining-work statements below are historical, not the current checklist.

Repair orders are persisted MongoDB projections with separate durable source
commands. They are linked to the existing appointment, customer, site, brand and
advisor. The frontend exposes a paginated list and board at
`/service/repair-orders`, detail/history at `/service/repair-orders/:id`, a
Customer 360 tab and timeline links, and an independently paginated My Day
exception queue. Board columns group the current page, not the entire database.

## Source ownership and current boundaries

This increment supports development simulation only. There is no generic RO
creation endpoint and no invented Pentana RO creation capability. A labelled
`simulate-from-appointment` action queues preparation of a simulated source record.
Live RO reads, source import/reconciliation, field mappings and permitted writes
remain blocked pending the authorised dealer integration path. Scraping/disabled
mode excludes simulated records and rejects simulation writes.

The existing appointment holds a vehicle description, not a customer-vehicle
projection. An RO copies that description and explicitly exposes
`vehicle_external_id: null`. This is not a verified customer-vehicle/VIN link.
Operations summary is the simulated appointment's service title. No operations,
parts, totals, invoices or payments can be changed through these endpoints.
Financial/source detail remains unavailable until actual source reads exist.

## API

All paths are under `/api/service/repair-orders` and require authentication.

| Method/path | Input / result |
| --- | --- |
| GET `/` | Required `siteId`; optional `status`, `search`, `customerId`, `appointmentId`, `brandId`, `assignedTo`, `offset`, `limit` |
| GET `/:id` | `siteId`; confirmed header, customer/appointment/advisor summaries, authority notes, transition history and latest 20 commands |
| GET `/my-day` | `siteId`, optional `date`, `view=own\|team`, `offset`, `limit`; authority, waiting-parts, ready and promised work through the site-local day |
| GET `/commands` | `siteId`, optional `appointmentId`, `offset`, `limit`; retained command outcomes, including pending simulation preparation |
| GET `/commands/:id` | `siteId`; sanitized command outcome |
| POST `/simulate-from-appointment` | `{siteId, appointmentId, promisedAt}`; development only; HTTP 202 |
| POST `/:id/transitions` | `{siteId, version, status, note}`; HTTP 202 |
| POST `/:id/authority-notes` | `{siteId, version, note}`; HTTP 202 |
| POST `/commands/:id/process-simulated` | ADMIN `{siteId}`; deterministic simulator processing, HTTP 200 |
| POST `/commands/:id/retry` | ADMIN `{siteId, note, confirmedNotApplied: true}`; reviewed unsuccessful command, HTTP 202 |

All three RO mutation submissions require `Idempotency-Key` (8–200 characters).
Keep the same key and body on a network retry. Replays return the same command;
changed requests using that key return 409. Pending/review commands block a second
command for the appointment. Versions and current permissions are checked at
submission and again at simulated source acknowledgement. Unsupported fields,
including financial edits, are rejected. Authority notes and transition reasons
are recorded separately. Both have timestamps and staff IDs.

Allowed simulated transitions:

- Waiting authority → in workshop.
- In workshop → waiting authority, waiting parts or ready.
- Waiting parts → in workshop or waiting authority.
- Ready → in workshop (rework).
- Invoiced → none. Invoice-issued state is source-owned; staff cannot invoice here.

`integration/repair-order.adapter.ts` contains development status mappings prefixed
`SIM_`. These must not be reused as eraPower codes. Simulation never marks a record
as accepted by Pentana.

## Queue and access

The existing customer command contract is customer-specific. ROs use the separate
`repair_order_commands` collection and a simulator worker in the CRM module. Both
workers use the existing integration configuration. Set `INTEGRATION_MODE=simulated`,
`ALLOW_SIMULATED_INTEGRATION=true`; normal simulator operation uses
`INTEGRATION_WORKER_ENABLED=true`. Simulation is prohibited in production by the
existing integration configuration. No new secrets or environment variables.

The RO simulator has no external side effects: source acknowledgement, projection,
command receipt and audit commit in one MongoDB transaction. A crash or audit error
rolls back all acceptance changes, leaving a durable pending request. Competing
processors serialize through the organisation revision; a replay cannot accept
twice. There is no external processing lease because there is no external runner
for this RO contract. A future live adapter needs claim/lease handling, source
receipts and verified read-after-write before it can be enabled.

The existing site simulator behavior control also exercises RO acceptance,
rejection, outage and uncertain outcomes. Outages retry with backoff and stop after
three attempts. Unknown outcomes require explicit ADMIN review; no automatic retry.
Audits retain each request/outcome and manual retry evidence. The board command
queue shows pending, retrying, rejected, failed and review states after reload.
These RO commands do not appear in the customer-only `/integration/commands` list.

Reads require `service.read` and `customers.read`, current site/brand access and
own assignment unless `service.view_team` is granted. Writes additionally require
`service.write` for the persisted brand. No new login roles. Shared customer
timeline RO events are filtered using current RO brand/assignment permissions.
My Day defaults to own work even for ADMIN; team view requires explicit selection.
Its overdue flag means promised before the selected site-local day. It is not a
live overrun alert. RO task creation/automatic follow-ups, check-in, technician
progress, collection, loan cars and customer-message linkage remain later work.

## Storage and verification

Startup creates `repair_orders` and `repair_order_commands` indexes, including
unique source IDs, one simulated RO per appointment, durable request keys and a
pending-command uniqueness guard. No SQL migration is needed for this MongoDB
implementation. Restart the backend to apply indexes and start the new worker.

Postman folder 34 adds 21 requests (34 folders / 290 requests overall). Run folders
32–33 first against disposable local fixtures. No real messages or Pentana writes.
Automated integration tests use a real temporary MongoDB replica set with a test
authentication guard. Supabase sign-in and browser acceptance are separate checks.

See `SCOPE-PROGRESS.md` for verification results and remaining work.
