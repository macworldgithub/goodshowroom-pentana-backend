# Step 3 backend: Customer 360 and My Day

All routes below use `/api`, a Supabase access token and current site permissions.
Copy `siteId` from `/auth/me` and a confirmed customer ID from `/customers` or a
successful create-command response. Actual Pentana/eraPower scraping remains last.

## Customer contact and privacy

- `GET /customers/:id?siteId=...`: confirmed profile and permitted linked tasks.
- `GET /customers/:id/activity?siteId=...`: shared timeline and authors.
- `PATCH /customers/:id`: `siteId` and partial `firstName`, `lastName`, `email`,
  `phone`, with `Idempotency-Key`. Returns HTTP 202 with a command.
- `PATCH /customers/:id/privacy`: `siteId`, complete `privacy`, Idempotency-Key.
  Example: `{ do_not_contact: false, email: "granted", sms: "unknown", call: "denied" }`.
  Channels accept unknown/granted/denied; do_not_contact is boolean.
- `GET /customers/:id/changes?siteId=...&offset=0&limit=10`: site-shared summaries.
  `state` maps queued/processing/retry_wait to pending, succeeded to confirmed;
  rejected/failed/needs_review stay explicit. Raw payloads/keys are excluded.
- `GET /integration/commands/:id`: detailed status for command creator or ADMIN.
- `PATCH /customers/:id/assignment`: `siteId`, `assignedTo`; requires
  customers.assign and validates active assignee customer access at that site.

Confirmed values change only after source acceptance. Updates require source-backed
customers in the configured mode; manual/CSV records need reconciliation first.
Only one unresolved source change is allowed per customer. Captured source revisions
prevent stale writes. Contact edits preserve privacy/assignment. Source responses
must match the requested changes and source ID. Unknown/mismatched results need
ADMIN review. Missing source privacy becomes unknown consent and cannot permit email.

Internal notes (`POST /customers/:id/notes`), call logs (`POST /customers/:id/calls`)
and paginated journal (`GET /customers/:id/journal`) remain append-only, site-shared.
Call logs record past activity and may atomically create a promised callback task.
Logging does not dial, grant consent, or import historical source notes/calls.

## Tasks and My Day

- `GET /tasks/:id?siteId=...`: current task and version.
- `PATCH /tasks/:id`: `siteId`, `version`, plus title/details/dueAt/priority/kind
  and/or assignedTo. Assignment requires tasks.assign and active same-site access.
- `PATCH /tasks/:id/cancel`: `siteId`, `version`, `reason`.
- `PATCH /tasks/:id/complete?siteId=...`: completes an open task.

Staff manage their own tasks; tasks.view_team permits team visibility. ADMIN has
team and assignment permissions. Stale edits return 409; terminal tasks cannot be
changed. Legacy task versions start at zero. Lifecycle changes join the timeline
under current ownership/team rules. Cancelled work is removed from My Day.

`GET /my-day?siteId=...&view=own` combines overdue/today follow-ups and scheduled
calls. Optional team view requires tasks.view_team. Date boundaries use the site's
timezone, including DST. bucket=all/overdue/today/calls; offset/limit paginate work.
Totals cover the entire authorized queue. Rows expose confirmed contact restrictions;
scheduling a call does not authorize contact. Future desks add appointments,
deliveries and collections when built.

## SMTP email

Server configuration (never put these credentials in Postman):

```dotenv
MESSAGE_TRANSPORT=smtp
SMTP_HOST=your-provider-host
SMTP_PORT=587
SMTP_FROM=your-verified-sender@example.com
SMTP_USER=your-provider-username
SMTP_PASSWORD=your-provider-password
```

Use your provider's SMTP details and verified sender. Port 587 requires STARTTLS;
465 uses implicit TLS; certificate validation stays enabled. A relay without login
may omit both auth fields, otherwise configure both together. Default transport is
disabled. SMTP supports email; SMS requires a separately selected provider.
See [Nodemailer SMTP documentation](https://nodemailer.com/smtp).

- `GET /messaging/status`: transport information without credentials.
- `POST /customers/:id/messages`: draft with siteId/subject/body, Idempotency-Key.
  Drafting sends nothing and can happen before consent is confirmed.
- `GET /customers/:id/messages?siteId=...&offset=0&limit=10`: paginated history.
  Staff see their drafts and shared submitted outcomes; ADMIN sees all drafts.
- `PATCH /messages/:id`: siteId/version, subject/body edits or cancel=true.
- `POST /messages/:id/send`: explicit send with siteId/current draft version and
  Idempotency-Key. Owner or ADMIN only. Requires confirmed granted email consent,
  do-not-contact false, confirmed recipient, and no pending privacy command.
  Recipient is taken from the customer; extra recipients are not accepted.
  Real SMTP cannot send simulated customer data.

States: draft, sending, accepted, delivered, bounced, rejected, needs_review,
cancelled. SMTP acceptance means submission acceptance, **not inbox delivery**.
Same-key retries return existing state without another submission. Uncertain
timeouts/disconnections need review; no automatic resend. Deterministic Message-ID
helps reconciliation but does not guarantee SMTP deduplication. SMTP effects run
outside retryable database transactions.

- `POST /messages/:id/recover`: ADMIN, siteId/note. Sending older than two minutes
  becomes needs_review after a process failure, without resending.
- `POST /messages/:id/resolve`: ADMIN, siteId/accepted-or-rejected status/evidence;
  accepted requires providerId. Verify the actual provider outcome first. No resend.
- `POST /messages/:id/delivery`: ADMIN, siteId/delivered-or-bounced status,
  matching providerId/evidence. Requires an accepted message. These are manually
  verified outcomes; automatic provider webhooks/DSN processing need a specific
  provider and are not implemented by generic SMTP.

Submitted outcomes join the shared customer timeline; drafts remain private.
No SMTP server was configured or live customer email sent during implementation.

## Postman development workflow

Use a disposable database and restart with:

```dotenv
INTEGRATION_MODE=simulated
ALLOW_SIMULATED_INTEGRATION=true
INTEGRATION_WRITES_ENABLED=true
MESSAGE_TRANSPORT=simulated
```

Import the collection and PRIVATE local environment. Log in and run existing
customer workflows first. Set runStep3Tests=true, then run folders 19, 20, 21.
They verify simulated modes, save IDs/versions, confirm queued updates, exercise
task reassignment/cancellation and simulated email submission/replay/delivery.
They refuse live SMTP. Set the flag false afterward. Folders 15–18 cover the
profile, timeline, My Day and notes/calls. Swagger provides editable request bodies.

Step 3's current backend email/task/customer scope is implemented. Live SMTP
configuration and acceptance, SMS integration, frontend screens and real source
scraping are separate remaining work; no production delivery verification is claimed.

## Frontend integration update — 13 October 2026

The frontend screens are now connected through Step 3. See
../my-app/FRONTEND-INTEGRATION.md for configuration, active routes and browser checks.
Gmail SMTP authentication has been verified; actual delivery has not been tested.
`GET /sites/:id/staff?offset=0&limit=100` provides a sanitized assignee directory
only with customer/task assignment permission. Entries expose userId, fullName and
current site permissions, excluding email and internal membership records.
Administrator membership lists now include authorized name/email display metadata.
The simulator worker is enabled locally; source writes remain simulation-only.
Postman currently contains 24 folders and 186 requests, including directory checks.
