# Good Showroom — implementation status and remaining backend plan

Reviewed 9 October 2026 against the backend source, generated Postman collection,
existing tests, and the supplied Good Showroom scope dated 1 October 2026.

## Basis and verification

The backend currently registers Auth, Context, CRM, and Database modules.
Postman has 13 folders and 64 requests. Requests repeat endpoints under different
roles and include external Supabase login/refresh operations; 64 requests does
not mean 64 distinct backend capabilities.

Checks run for this review:

- Backend unit suite: 29 tests passed across five files.
- Endpoint suite: four tests passed across three files, using mocked providers.
- Postman scope checks: five checks passed; all collection scripts parse.
- MongoDB integration suite: the temporary MongoDB server failed during startup
  with an internal assertion; all 12 tests were skipped. These database behaviours
  therefore remain unverified by this review's integration run.

The live Postman workflows were not executed during this review. Existing code,
test coverage, and successful live behaviour are separate evidence categories.

## Implemented: retain and extend

### Identity and staff access

- Supabase bearer-token verification; current access checked against MongoDB
  memberships rather than trusting role metadata supplied by the client.
- Setup-key-protected initial identity creation and first organisation/site setup.
- `/auth/me` and `/context` expose identity, memberships, accessible sites,
  permissions, and setup state.
- ADMIN-only direct staff account creation with confirmed Supabase identity,
  local profile, memberships, and audit events.
- ADMIN, SALES, SERVICE roles and an allowlist of additional permissions.
- Membership listing, role/status/extra-permission updates, suspension/restoration,
  and protection for the last active administrator.
- Invitations: create, organisation listing, recipient listing, send email,
  revoke, expire, and accept through a matching confirmed identity.
- Email failure diagnostics return provider codes and actionable guidance.

Evidence: `src/auth/*`, `src/context/context.controller.ts`.

Supabase login and token refresh are external operations included in Postman,
not NestJS login/refresh endpoints. Password callback/setup/recovery was implemented
in `../my-app`; these are frontend capabilities, not new backend controllers.

### Basic customers and tasks

- Site-authorised customer creation and search/listing.
- Customer creation records a manual source and initial assignee.
- Follow-up creation with customer, title, details, due date, and priority.
- Task listing with customer-name context, own-task restrictions, and optional
  team visibility.
- Completion with ownership checks and repeat-completion rejection.

Evidence: `src/crm/customers.controller.ts`, `src/crm/tasks.controller.ts`.

### Database, audit, and documentation

- MongoDB replica-set/Atlas requirement, transactions, and indexes.
- Audit recording for implemented mutations and an ADMIN audit-list endpoint.
- Customer `source` and `external_ids.pentana` fields, with a partial unique index
  for the Pentana ID within an organisation.
- Swagger UI, bearer authentication, and editable request schemas.
- Postman role workflows, variable fallback, automatic token/ID capture, and
  optional suspension, invitation-email, additional-admin, and refresh requests.

Evidence: `src/database/*`, `src/swagger.ts`, `src/api-bodies.ts`, `postman/*`.

## Partial capabilities and confirmed gaps

### Site and brand access

Initial setup creates one site; accessible sites can be read through context.
There are no general site create/edit/list management endpoints, brand records,
or brand-scoped access checks.

Site assignment is not yet mandatory for SALES/SERVICE. Both `staff()` in
`user-provisioning.service.ts` and `invite()` in `staff.controller.ts` convert an
omitted site to null. Only ADMIN-with-a-site is rejected. Null memberships are
treated as organisation-wide by `AccessService`. Membership updates also permit
changing an organisation-wide ADMIN to SALES/SERVICE while retaining null scope.
This needs an explicit policy and validation on every grant/change path.

### Customer and task APIs

Customers lack a detail endpoint, contact editing, reassignment, timeline,
vehicles, privacy flags, and linked commercial/service records. Customer creation
currently writes directly to MongoDB; it does not submit a source-system command.

Tasks lack editing/rescheduling, reassignment, broader lifecycle handling, and
links to deals/repair orders/appointments. Existing assignment permissions do
not provide assignment endpoints. List endpoints use fixed limits rather than
client pagination.

### Audit and integration preparation

Existing audit rows cover local operations. There is no external command ledger,
request/response write-back audit, failed-command view, reconciliation, audit
export, or demonstrated seven-year retention arrangement.

Pentana ID fields are preparation only. There is no adapter contract, simulated
adapter, sync worker, durable queue, retry/idempotency processing, or real adapter.

### Product capabilities absent

No backend modules/endpoints currently implement:

- Customer thread events, internal notes, calls, SMS/email customer messaging,
  delivery webhooks, or consent enforcement. Invitation emails are not CRM messaging.
- Full My Day aggregation across appointments, work queues, deliveries,
  collections, and promises. The current task list is only one input.
- Vehicle stock/customer vehicles, enquiries, leads, pipeline, appraisals,
  quotes/deals, reservations, or delivery checklists.
- Service diary, booking operations, repair orders, check-in/collection,
  capacity rejection, loan cars, declined work, or no-show recovery.
- Sales-to-Service handover, PDI/accessories, or first-service booking.
- Cross-desk management views, role-specific operating queues, or AI assistance.
- Operational readiness/liveness endpoints, queue monitoring, and production
  hosting/backup/restore/retention configuration demonstrated by this review.

## Postman coverage assessment

Folders 00–04B cover account/access setup and administration. Folders 05 and 06
test the same basic customer/task operations with SALES and SERVICE identities;
they do not implement or test the scope's actual Sales and Service desks.

Folder 07 checks authentication boundaries. Folders 08–10 are optional and gated
by flags. Initial setup, direct creation, and invitation requests can also skip
based on saved variables. An unexecuted/skipped request is not successful coverage.

The collection contains no requests for the missing product modules. It also lacks
invitation revocation and a dedicated last-admin-protection scenario, although
these behaviours exist in source/tests. The unrelated-site check defaults to a
nonexistent UUID; a real second-site fixture is needed for stronger isolation proof.
There is no test preventing omitted-site SALES/SERVICE grants.

## Remaining implementation order — real Pentana last

### Batch 1: finish site/brand and access foundations

Retain the existing auth/invitation services. Enforce the agreed scope policy for
direct creation, invitations, acceptance of legacy invitations, and role changes.
Assess existing null SALES/SERVICE memberships before any migration; do not
silently reassign live users. Add site management and brand mapping/access.
Keep the single organisation internal and preserve first-admin bootstrap protection.
Add pagination and the missing Postman access scenarios. Repair the isolated
database test startup so its existing suite can run.

Acceptance: ADMIN manages sites; staff require explicit authorised scope; tests
prove isolation against a real other site, including invitation and update paths.

### Batch 2: integration contract, simulated adapter, and command processing

Define normalized source models and an adapter interface for the required reads
and writes. Mark provisional assumptions explicitly. Introduce a development-only
adapter with representative fixtures, rejection/outage simulation, and clear labels.
Add durable commands, idempotency, retries, failure status, request/response audits,
and administrative recovery. Refactor production customer changes through commands.
Good Showroom owns tasks/drafts/conversation bodies; source-owned records are projections.

Acceptance: repeated commands do not duplicate records; rejection never appears
as accepted; fixture mode cannot accidentally serve production as real Pentana.

### Batch 3: Customer 360, thread, and expanded My Day

Extend existing customer/task endpoints with customer detail and linked views,
notes/calls/timeline events, source-owned privacy fields, task assignment and editing,
and combined day queues. Add messaging via the scope's existing channels once their
interfaces are confirmed, privacy checks, delivery outcomes, and activity mirrors.

Acceptance: pilot-role workflows operate on the shared thread; restricted contact
is blocked; team and personal queues respect site/brand/role permissions.

### Batch 4: Sales desk

Build stock and customer vehicles, enquiries/leads, configurable pipeline mappings,
appraisal requests, deal summaries, assignment, reservation/release commands,
activity-backed stage changes, and delivery checklists. Commercial totals remain
source-owned rather than calculated as a replacement DMS ledger.

Acceptance: the scope's sales-day script passes against the simulated adapter,
including invalid transitions, rejected reservations, and duplicate retries.

### Batch 5: Service desk

Build appointments/diary, create/move/cancel/confirm commands, repair-order boards,
supported transitions, authority notes, check-in/collection, customer updates,
loan-car handling, and no-show/declined-work follow-ups. Capacity authority remains
external; simulated capacity rejection is used during development.

Acceptance: the service-day script passes with privacy blocks, denied capacity,
outages, site isolation, and visible write failures.

### Batch 6: handover and group views

Connect delivery, PDI/accessories, customer preferences, and first-service booking.
Add cross-desk manager/principal views and further-site configuration. Add AI draft
and next-action assistance only after workflow data is available; people send messages.

Acceptance: Sales and Service share vehicle/customer handovers and approved group views.

### Batch 7: actual Pentana/eraPower scraping and production acceptance — LAST

The confirmed integration method is scraping for BOTH reads and writes. Do not
build or connect the actual Pentana/eraPower scraper during the earlier batches;
develop and verify those workflows against the simulated adapter instead.
At this final batch, obtain dealer-authorised access; confirm the actual product
version, site/brand/record IDs, field/status mappings, permissions, and supported UI
writes. Connect the user's scraping runner to the existing import and command
claim/heartbeat/result protocol. Verify login/session handling, page navigation,
selectors, external pagination, incremental reads, and stable source IDs.
Reconcile pilot data, prove reads first, then a controlled customer write, and
enable subsequent supported writes individually. Uncertain submissions must be
reconciled rather than automatically repeated. Validate every earlier workflow
against actual source behavior; simulated contracts are provisional.
Reserve time for provisional-contract changes. Verify Australian hosting,
secrets storage, monitoring, backup restoration, audit retention, and performance.

Acceptance: the scope's phase scripts work against real Pentana with pilot users.
Until then, application features are verified against simulation, not accepted as
production Pentana-compatible workflows.

## Recommendation

Start with Batch 1 and then Batch 2. Do not rebuild working authentication,
invitations, customer/task basics, audit recording, or Swagger. Extend them.
Every new batch should ship its backend routes, Swagger schemas, Postman examples,
positive/negative tests, and simulated integration behaviour together.

## Implementation progress — 9 October 2026

Batch 1, first increment: site assignment enforcement implemented.

- Shared scope policy used for direct provisioning, invitation creation, legacy
  invitation acceptance, and active membership updates. SALES/SERVICE require an
  explicit site; ADMIN requires organisation-wide scope. Mixed ADMIN/staff grants
  must be issued separately because their scopes differ.
- Membership PATCH accepts `siteId` for explicit administrator correction or
  reassignment, checks organisation ownership, and retains last-admin protection.
- Legacy unscoped staff records are not migrated or reassigned. They no longer
  authorize site access or appear as accessible sites. Administrators can list
  them, assign a valid site, or suspend them; restoration requires valid scope.
- Invitation acceptance validates the stored role/scope and current site before
  granting access; rejected acceptance rolls back within the MongoDB transaction.
- Swagger updated; Postman now has 14 folders and 68 requests, including four
  omitted-site rejection checks. Live requests have not been rerun.

Verification: 43 unit tests and 4 endpoint tests pass; backend build passes.
Postman script syntax and five variable-resolution checks pass. Database
integration tests were not rerun in this increment, so transaction rollback and
real database isolation still require verification.

Next increment: general site management and brand mapping/access, followed by
pagination, stronger database access tests, and then Batch 2 integration architecture.
The earlier review findings above describe the state before this increment.

## Batch 1 implementation completed — 9 October 2026

The access foundation now includes ADMIN site create/edit/list, brand
create/edit/list, site-to-brand mappings, optional staff brand restrictions,
brand authorization, accessible-brand routes, and per-brand context permissions.
Every access-grant path validates scope, including legacy invitation acceptance.
Existing customers/general follow-ups retain their site-neutral sharing policy;
future brand-owned records must enforce the dedicated brand permission check.
Site/brand changes are transactional and audited. No live data migration was run.

All directory/CRM lists now accept bounded offset/limit pagination with stable
sorting for unchanged data and explicit next-page metadata. Context remains a full
access summary. Names remain exact/case-sensitive under the database unique indexes.

Database startup was verified outside the Windows sandbox; no application database
change was needed. The expanded temporary-replica-set suite passes, including real
second-site isolation, per-brand role isolation, grant validation, legacy membership
correction/reassignment, invitation rollback, pagination, and last-admin concurrency.

Verification: 59 unit tests, 4 endpoint tests, and 19 MongoDB integration tests pass;
build and lint pass. Postman now has 15 folders and 89 requests; all scripts parse
and five variable-resolution checks pass. New fixture management scenarios are
optional (runFoundationManagementTests=true) and use a real second site. Live
Postman/Supabase requests were not rerun. See README.md for routes and scope policy.

Next: Batch 2 — normalized integration contracts, a clearly labelled simulated
adapter, durable idempotent commands, retry/rejection handling, and admin recovery.
The original review sections above record the pre-implementation findings.

## Batch 2 implementation — 9 October 2026

The user confirmed that their Pentana integration will use scraping for BOTH reads
and writes. The backend now provides a scraping-runner protocol rather than assuming
an undocumented Pentana API or implementing browser selectors without source access.

Implemented:

- Explicit disabled / development-simulated / external-scraping modes and startup
  production protection. Simulation data and linked tasks are labelled and isolated
  from scraping/disabled CRM lists. Actual environment credentials/configuration
  were not changed; integration remains disabled unless explicitly configured.
- Provisional normalized entity contracts; executable customer read imports and
  customer.create writes. Other desk entity types are preparation for their steps,
  not working stock/deal/appointment/repair-order APIs.
- Durable MongoDB commands, per-user/organisation idempotency and request hashes,
  atomic claims, five-minute leases/renewal, request/response attempt audits,
  backoff, three automatic attempts, failure states, and ADMIN recovery/reconciliation.
- Durable simulator source receipts make replay safe after a crash between source
  acceptance and local projection. Rejection never creates a customer. Source
  exceptions and mismatched acknowledgements remain visible as needs_review.
- Scraping-runner ADMIN endpoints for importing observations, claiming queued writes,
  heartbeat, reporting outcomes, and reviewing attempts. Only certified not_applied
  results can auto-retry. Expired/uncertain browser writes require source verification
  before manual retry or resolution; idempotency cannot make UI writes exactly once.
- Incremental atomic read imports preserve assignments/internal IDs, deduplicate
  external IDs, ignore older observations, and reject cross-site/same-time conflicts.
- Customer POST now requires Idempotency-Key and returns 202 pending command instead
  of directly inserting a local customer. Poll the status and wait for confirmed
  customer.id before creating tasks. Auth/invitation functions remain unchanged.
- Swagger schemas, updated role workflows, and optional/manual Postman runner/recovery
  examples. The collection now has 17 folders and 113 requests.

Verification: 67 unit tests, 4 endpoint tests, and 34 real temporary-MongoDB
integration tests pass; build and lint pass. All Postman scripts parse and the five
variable-resolution checks pass. No live Pentana, browser scraping, Supabase email,
or live Postman write was executed.

See INTEGRATION-RUNNER.md for setup and the runner protocol. The real scraper remains
the user's connection work: dealer/site/ID mappings, selectors, supported UI writes,
and verified observations are not established by simulated tests. Runner endpoints
currently use existing ADMIN sessions; an unattended production deployment still
needs a dedicated least-privilege machine identity and operational configuration.
Read reconciliation/retention and additional command kinds extend with later steps.

Next implementation batch: Customer 360 and expanded My Day. The original review
sections above describe the state before these increments.

## Forward plan confirmed — 12 October 2026

Actual Pentana/eraPower scraping is the LAST implementation stage, for BOTH reads
and writes. The existing runner boundary remains infrastructure only. Until that
stage, use simulation for all source-owned customer, stock, deal, appointment,
repair-order, and handover behavior; no live scraping/write-back claim is implied.

Proceed in this order:

1. Restore local backend testing by resolving the current Cluster0 TLS connection
   failure. This operational blocker does not require implementing the real scraper.
   Validate the configured Postman flows against simulation once startup succeeds.
2. Batch 3: Customer 360 and My Day. Customer detail and queued source-owned contact
   edits, shared history/notes/calls, privacy/consent, task editing/rescheduling/
   assignment, and personal/team day queues. Add customer messaging through confirmed
   channel interfaces, with consent enforcement and delivery outcomes. Extend
   normalized simulator contracts and commands alongside these capabilities.
3. Batch 4: Sales desk. Enquiries, leads/pipeline, vehicle stock, appraisals,
   deals, reservations/releases, and delivery checklists. Source-owned commercial
   values remain simulator projections, not a new accounting ledger.
4. Batch 5: Service desk. Appointments/diary, repair orders, check-in/collection,
   supported work transitions, customer updates, loan cars, and recovery follow-ups.
   Simulate capacity rejection and source failures.
5. Batch 6: Sales–Service handover and management views. PDI/accessories, first-service
   booking, shared vehicle/customer handover, role-aware queues, and group reporting.
6. Complete the portal frontend against the tested backend: ADMIN site/brand/staff
   screens and Sales/Service workspaces, including pending/rejected/needs-review
   command feedback. Existing frontend customer submission needs the new queued
   creation flow before its customer action can be considered working. Frontend
   work may accompany each batch; all end-to-end portal workflows must be verified
   against simulation before moving to real scraping.
7. Final batch only: connect the actual Pentana/eraPower scraper, verify real reads
   and writes, reconcile source data, handle sessions/UI changes, and validate every
   supported workflow. Complete dedicated runner identity/permissions, monitoring,
   backups/restore, retention, hosting, and pilot acceptance before production.

Every functional batch includes routes, Swagger, Postman examples, permission and
failure tests, and representative simulator behavior. Previously passed tests are
historical verification; rerun appropriate checks after each change. The 17-folder,
113-request collection is current coverage, not evidence of completed operating
modules or live Pentana compatibility.

## Customer 360 increment 1 — 12 October 2026

Customer detail is available at GET /api/customers/:id?siteId=...&offset=0&limit=10.
It returns contact/source/assignment, authorised site metadata, assignee name (no
staff email/credentials), and a page of linked follow-ups. Customers remain shared
within their authorised site; staff see only their own tasks unless tasks.view_team
is granted. Lookup consistently enforces organisation, site, integration mode, and
current permissions. This is profile detail, not the future shared activity timeline.

The portal opens the profile when a customer name is clicked. It shows permitted
follow-ups with paging and an Add follow-up action. The profile uses site timezone,
labels simulation, supports keyboard dismissal/focus containment with a native dialog,
and has a bounded scroll area and visible actions on desktop/mobile.

Portal customer creation now supplies an idempotency key, retains it for retry of
an unchanged draft after a request failure, and displays queued creation with a
manual status check. Pending command IDs are retained per user in session storage.
No unconfirmed customer can be used for follow-ups. Status hiding does not cancel
a command. With the deterministic Postman configuration (worker disabled), process
simulated commands through the ADMIN Postman request before checking portal status.

Postman adds folder 15 Customer 360 — profile and linked follow-ups, covering both
staff roles, ADMIN task visibility/paging, unavailable IDs, authentication, invalid
pagination, and optional real second-site isolation. Collection/environment exports
were regenerated, retaining existing private account settings and runtime IDs.
There are now 18 folders and 121 requests.

Tests verify profile context, linked-task owner/team visibility and paging, no staff
contact leakage, unknown IDs, cross-site/mode isolation, and immediate suspension.
Desktop/mobile profile layout was visually checked using a temporary fixture page;
that page and preview server were removed. Actual Pentana scraping remains LAST.

Next increment: shared customer activity history, then notes/calls. Customer edits,
privacy/consent, expanded task management, My Day, and messaging follow in order.

## Customer 360 increment 2 — backend only, 12 October 2026

Customer detail/profile already existed in the working tree. Continued with the
next ordered increment: GET /api/customers/:id/activity?siteId=...&offset=0&limit=10.
It presents customer/source and permitted task events with readable summaries,
authors, timestamps, and pagination. Customer/site/mode checks and task permissions
are applied before pagination; raw ADMIN audit metadata is never returned.

Source read imports now atomically record meaningful per-customer import/refresh
activity. Duplicate/stale observations add no activity, and failed batches roll
back both projections and events. Existing customer/task audit history is reused;
earlier site-only source imports are not backfilled with invented customer events.
Added audit/task lookup indexes. All work in this increment is backend/documentation/
Postman; no frontend file was changed. Pentana/eraPower scraping remains LAST.

Postman adds folder 16 Customer 360 — activity history; there are now 19 folders and
128 requests. Collection and local/private environments regenerated; existing private
credentials/runtime IDs retained. Unit, endpoint, and database tests check regressions
and activity authorization/pagination, source history, privacy, and rollback.

Next increment: internal customer notes and call logging, backend and Postman only.

## My Day initial backend increment — 12 October 2026

Added GET /api/my-day with optional date, own/team view, all/overdue/today/calls
bucket, and pagination. The selected site timezone determines actual calendar-day
boundaries, including 23/25-hour DST days. Counts use the same authorised snapshot
as the returned queue, before page/bucket filtering. Only open permitted tasks with
matching customer/site/organisation/integration mode are shown. ADMIN defaults to
personal view; team view requires tasks.view_team. Suspended membership is rejected.

Task creation now accepts kind=call to schedule a call task. This is not internal
call logging/outcomes or actual dialling. Legacy tasks default to follow_up.
My Day covers current tasks and call tasks; Sales/Service appointment/delivery/
collection inputs remain unimplemented. No frontend or real Pentana scraper changed.

Current Step 3 status:
1. Customer detail/profile backend: implemented, with linked follow-ups.
2. Shared activity: implemented for current creation/source-refresh/task events;
   future contact-edit/privacy/call/message events await those implementations.
3. Internal notes and logged calls/outcomes/promises: pending. Scheduled call tasks
   are supported by My Day, but do not complete this item.
4. Customer editing commands: pending; customer.create is the only executable write.
5. Privacy/consent fields and enforcement: pending.
6. Task management: creation/listing/completion and call scheduling exist;
   editing/rescheduling/reassignment/cancellation endpoints remain pending.
7. My Day: initial backend implemented for tasks/call tasks; operating-desk inputs
   follow their Sales/Service batches.
8. Customer messaging: pending, including provider confirmation and consent checks.

Postman folder 17 My Day — personal and team queues added. Collection has 20 folders
and 140 requests; local/private exports refreshed with existing account settings
retained. Test verification: 77 unit tests, 4 endpoint tests, and 39 temporary-MongoDB
integration tests pass; build passes. Postman scripts parse and five variable-scope
checks pass. No live Postman/Pentana requests were executed by this increment.

Next: internal notes and call logging, then customer edits/privacy and expanded task
management. Actual Pentana/eraPower read/write scraping stays LAST.
