# Pentana scraping runner contract

Current customer commands include customer.create, customer.update and
customer.privacy_update. Updates include external_id and expected_revision; the
runner must verify the source revision before submitting an edit, preserve unrelated
fields, and return the complete confirmed contact/privacy record with a new revision.
If privacy cannot be verified, report unknown rather than claiming success. Only one
unresolved source change per customer is allowed. The simulator tests these contracts;
actual scraping stays the final stage. Normalized observations may include privacy
with do_not_contact and email/sms/call unknown/granted/denied states. Omitted privacy
is treated as unknown consent. See CUSTOMER-360.md for the Step 3 workflows.

Step 2 provides the backend boundary for read and write scraping. It does not log
into Pentana or assume selectors, dealer permissions, field names, or supported UI
operations. Your runner owns the browser session, Pentana credentials, source/site
mapping, and evidence used to confirm a write. These interfaces are provisional
until tested against the dealer's actual system.

## Modes

Default INTEGRATION_MODE=disabled: existing reads/auth/tasks remain available;
new source-owned customer writes return 503 instead of silently creating local records.

For development:

```dotenv
INTEGRATION_MODE=simulated
ALLOW_SIMULATED_INTEGRATION=true
INTEGRATION_WORKER_ENABLED=true
```

Simulation is rejected at startup with NODE_ENV=production, even when opted in.
Simulation data uses separate source receipts, external_ids.simulated, and explicit
mode/source labels. Production/disabled/scraping customer and task lists exclude
simulated records; simulation lists exclude scraped projections. Use a separate
development database as well. Old command history remains visible to administrators
and is labelled by its original mode. Commands cannot change integration mode.

For your scraping runner:

```dotenv
INTEGRATION_MODE=scraping
INTEGRATION_WRITES_ENABLED=true
INTEGRATION_WORKER_ENABLED=true
```

The backend worker only recovers expired scraping leases. Your external runner
executes browser reads/writes. INTEGRATION_WRITES_ENABLED=false permits read imports
but blocks enqueue/claim/retry of writes. An active claim may still acknowledge its
actual outcome after writes are disabled. No scraping mode falls back to simulation.

## Authentication and mapping

All runner routes use the existing Supabase bearer guard and current organisation
ADMIN membership. Use an operator-controlled ADMIN session belonging to the dealer.
There is currently no separate machine identity or least-privilege runner role;
add that before an unattended production deployment. Do not put service-role keys,
Pentana credentials, cookies, raw HTML, or tokens into command bodies/diagnostics.
The backend never receives Pentana login credentials through these routes.

Use the internal site UUID from ADMIN sites/context and map it explicitly to the
correct Pentana dealer/site in the runner. Source customer IDs must be stable and
unique within the organisation; this is a provisional assumption. If Pentana IDs
are only unique within a branch, confirm the mapping contract before importing.
A source ID already mapped to another site returns 409 rather than silently moving
customer ownership. Brand-owned entities will use the brand permission checks from
step 1; current customer identity records are site-neutral.

## Reads: normalized customer observations

POST /api/admin/integration/customers/import accepts a siteId and 1–100 customers:

```json
{
  "siteId": "INTERNAL_SITE_UUID",
  "customers": [{
    "external_id": "ACTUAL_STABLE_SOURCE_ID",
    "revision": "ACTUAL_SOURCE_REVISION_OR_CONTENT_HASH",
    "observed_at": "2026-10-09T09:00:00Z",
    "first_name": "Test",
    "last_name": "Customer",
    "email": "test@example.test",
    "phone": null
  }]
}
```

Provide actual normalized observations. At least one contact method is required.
The import is one atomic batch: any invalid/cross-site/conflicting record rolls the
batch back. It upserts projections by organisation + mode + external ID, retaining
internal IDs, creator, assignee, and creation timestamp. Repeated observations do
not duplicate records. Older observations return the existing projection without
overwriting it; equally timed conflicting observations return 409. observed_at must
represent the source observation time consistently; revision is opaque, not sorted.
The importer does not infer deletions from missing rows and does not implement
full reconciliation, scheduled scraping, or pagination of the external browser UI.
Split large reads into batches in the runner.

Normalized vehicle, deal, appointment, and repair-order types are defined in
src/integration/contracts.ts for later desks. Only customer reads/imports and
customer.create writes are executable in this batch; future commercial status/ID
maps and writes are deliberately not invented.

## Writes: submit once, confirm before projecting

1. The application calls POST /api/customers with the existing camelCase contact
   body plus Idempotency-Key (8–200 characters). It receives HTTP 202 and command.
   There is no customer row yet. Reuse the exact key/body on network retries. Keys
   are scoped to the requesting user and organisation; changed payload/site/mode
   under the same key returns 409. Retain keys for as long as a retry may arrive.
2. Poll GET /api/admin/integration/commands?organisationId=...&status=queued and
   retry_wait, using offset/limit. Filter to mode=scraping, kind=customer.create,
   mapped sites, and available_at <= now in the runner. Paging is not a snapshot.
3. POST /api/admin/integration/commands/:id/claim with {}. Exactly one claimant
   gets HTTP 200, leaseToken, leaseExpiresAt, and the command payload. The source
   requester's site write permission is rechecked; revoked access rejects the command
   before browser submission. Losing a claim returns 409 and must not cause a write.
4. Execute the browser operation outside database transactions. Use command.id as
   a durable correlation key in your runner's own journal. Do not infer success
   from a click or page load: reread the created source record and its stable ID.
5. During long actions, POST /api/admin/integration/commands/:id/heartbeat with
   leaseToken before expiry (for example every 60 seconds). Each renewal extends
   the current lease five minutes. An expired/incorrect token returns 409; do not
   submit another write to obtain a new lease.
6. POST /api/admin/integration/commands/:id/result with leaseToken and one outcome:
   - succeeded: include customer using the normalized format above. Its contact
     fields must match the queued request after normalization. A mismatch becomes
     needs_review, retaining the reported response in the ADMIN attempt audit.
   - rejected: code/message explaining a definite source rejection. Terminal;
     correct the request and submit a new idempotency key.
   - not_applied: code/message certifying the write was never submitted/applied.
     This is the ONLY scraping outcome eligible for automatic requeue. A timeout
     after clicking Submit does not qualify.
   - unknown: code/message when the source effect cannot be confirmed. Terminal
     needs_review; no automatic second submission.
7. The app polls GET /api/integration/commands/:id. Only the original requester
   (with current site access) or an ADMIN can see the command. On succeeded it
   includes the confirmed customer. Only then may a follow-up task use customer.id.

A 202 is queue acceptance, not Pentana acceptance. Idempotency prevents duplicate
commands and duplicate local projections; it cannot by itself make browser writes
exactly once. Safe scraping depends on reporting uncertainty and reconciling the
source before retrying. An ADMIN can report a result, but the backend cannot
independently prove browser observations without the actual adapter/source access.

If result reporting fails after source submission, retain the lease/outcome/evidence
and retry the report while the lease is valid; NEVER repeat the source submission.
A duplicate report after a confirmed result returns 409, and command status can be
read to verify its existing outcome. A source ID/projection conflict leaves the
attempt processing until lease recovery; examine the source, then resolve it.

## Retries, failure visibility, and reconciliation

The queue persists through process restarts. A claim creates a durable request audit;
completion records the normalized source response and local processing outcome.
Definite not_applied outcomes back off exponentially (2s, 4s) and fail after three
attempts. Queued retry_wait commands stay visible with available_at/error fields.
ADMIN retry authorizes one further attempt; attempt numbering/history never reset.

Expired simulator leases can replay safely because the simulator stores one durable
source receipt per command, separately from the local projection transaction.
Expired scraping leases ALWAYS become needs_review, even if the browser may have
completed the action. The enabled backend worker handles lease expiry, or an ADMIN
can POST /api/admin/integration/recover with organisationId. Recovery is bounded to
100 expired commands per call/cycle.

ADMIN routes:

- GET /api/admin/integration/commands?organisationId=...&status=needs_review
  (also failed/rejected/retry_wait) exposes visible failures with pagination.
- GET /api/admin/integration/commands/:id/attempts exposes request/response evidence
  to administrators, with pagination. Lease tokens appear only in the claim result.
- POST /api/admin/integration/commands/:id/retry requires note. For needs_review,
  confirmedNotApplied=true is required AFTER checking the source and runner journal.
  Do not assert this just to unblock the queue. rejected/succeeded cannot be retried.
- POST /api/admin/integration/commands/:id/resolve requires note and a verified
  succeeded + customer or rejected + code/message result. It resolves needs_review
  without another browser write and preserves the original attempt evidence.

There is no automatic claim cancellation, external reconciliation scan, notification
provider, retention policy, or unattended runner deployment in this batch. Source
privacy fields and additional command kinds will be added with their workflow steps.

## Simulator and verification

POST /api/admin/integration/simulator/sync with siteId imports two clearly named
customer fixtures plus accepted simulator records. Repeated syncs do not duplicate.
POST /api/admin/integration/simulator/behavior with siteId, behavior
(accept/reject/outage/unknown), and count (1–100) affects the next attempts for that
site. Controls are ADMIN-only and rejected outside simulation.
POST /api/admin/integration/commands/:id/process with {} processes a specific
simulator command for deterministic tests; it is unavailable in scraping mode.
For deterministic Postman runs, INTEGRATION_WORKER_ENABLED=false avoids racing the
manual process endpoint. Processing a completed simulator command is a no-op.

Postman folders 05/06 now queue a customer, process it in simulation, and retrieve
its confirmed ID before creating a follow-up. In scraping mode, pause until the
external runner completes the command, then rerun the status request. Folder 13
includes optional command/idempotency/sync checks. Folder 14 is a set of manual
runner/recovery examples for distinct states, not a runnable sequential workflow.
No example fabricates a success acknowledgement automatically. Live Pentana/browser
and Supabase/Postman runs remain separate from the temporary-MongoDB tests.
