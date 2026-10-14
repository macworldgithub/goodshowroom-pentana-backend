# Good Showroom Backend

NestJS API with Supabase Authentication and MongoDB as the application database.
Supabase stores identities and sessions. MongoDB stores organisations, sites, user profiles,
memberships, invitations, customers, tasks, and audit events. The backend does not use
Supabase Postgres tables or RPC functions.

## Configuration

Copy `.env.example` to `.env` and configure:

- `SUPABASE_URL` and `SUPABASE_ANON_KEY` (or `SUPABASE_PUBLISHABLE_KEY`).
- `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) for direct account creation and invitation emails.
- `MONGODB_URI`: MongoDB Atlas or a local replica set. Standalone MongoDB is not supported.
- `MONGODB_DATABASE`: a dedicated application database, for example `good_showroom`.
- `INITIAL_SETUP_KEY`: a long random secret used only for first dealership setup.
- `AUTH_INVITE_REDIRECT_URL`: your frontend invitation callback, allowed in Supabase Auth settings.
- `WEB_ORIGIN`: the permitted frontend origin.

Never place MongoDB credentials or the Supabase secret/service-role key in frontend variables.
Configure Australian hosting for customer data as required by the scope.
Disable public sign-up in Supabase. Create the initial account through the setup-key-protected
`POST /api/auth/initial-user` route, or use an existing confirmed account from the dashboard.

Install with `pnpm install`; start with `pnpm start:dev`. The API prefix is `/api` and the
default port is 4000. Startup connects to MongoDB, checks transaction support, and creates
indexes. Enable replica-set mode for local MongoDB; Atlas supports the required transactions.
The MongoDB account needs collection/index creation and read/write permissions on this database.

Do not apply the SQL files under `supabase/migrations`: they are retained historical files
from the prior Postgres implementation, not part of this setup. This change does not migrate
any records previously stored in Supabase Postgres. Existing deployments need an explicit,
validated data migration before switching databases.

## Swagger API explorer

After starting the backend, open `http://localhost:4000/api/docs` to browse and test
all backend routes. The OpenAPI JSON is at `http://localhost:4000/api/docs-json`.
Use your configured port if it differs from 4000.

Sign in through Supabase using the Postman login request, then click **Authorize**
in Swagger and paste the returned `access_token` without the `Bearer` prefix.
Run `GET /api/auth/me` to find your organisation and site IDs. Expand a route,
click **Try it out**, edit the example body/parameters, and click **Execute**.
The body you enter is sent directly; no Postman scripts replace it.

Initial account creation uses the setup key without bearer authentication; setup
requires both the key and a signed-in confirmed user. Staff creation requires an
ADMIN token. Replace sample credentials and UUIDs before executing. Swagger runs
real requests, including account creation and record updates. Supabase login is an
external service and is not a backend route in this explorer. No secrets from
`.env` are included in the generated documentation.

## Authentication and access

The frontend obtains a Supabase access token and sends `Authorization: Bearer <token>`.
NestJS verifies the user through Supabase `getUser(token)` and checks current MongoDB
memberships for each protected operation. Client metadata and JWT role claims do not grant access.

Roles: `ADMIN`, `SALES`, `SERVICE`. A user may hold multiple memberships/roles.
Memberships are scoped to an organisation and optionally a site. `ADMIN` is organisation-wide.
Suspending a membership removes that grant on subsequent requests; suspend every membership
for a user in that organisation to remove all of their access there.

SALES and SERVICE can read shared customer identity within their authorized site and create
customers/follow-ups. Their task list and completion actions are limited to their own tasks
unless `tasks.view_team` is granted. ADMIN can manage staff and read audit history.

Supported additional permissions:
`customers.view_team`, `customers.assign`, `tasks.view_team`, `sales.view_team`,
`sales.assign_leads`, `service.view_team`, `service.assign_work`.
Additional permissions never grant `users.manage`. Some names are reserved for future
assignment/sales/service endpoints and do not imply those features already exist.

## First dealership setup

1. For a new account, call `POST /api/auth/initial-user` without a bearer token, with
   `email`, `password` (12 to 128 characters), optional `fullName`, and `setupKey`.
   This uses the backend's Supabase admin key to create a confirmed staff identity.
   It sends no email and grants no application role yet. Existing accounts may skip this step.
2. Sign in with that account and call `GET /api/auth/me`; an empty installation reports `needsInitialSetup: true`.
3. Call `POST /api/setup` with `organisationName`, `siteName`, `timezone` (optional,
   default `Australia/Sydney`), and `setupKey` matching `INITIAL_SETUP_KEY`.
4. The backend creates one organisation, one site, and an active organisation-wide
   ADMIN membership for the signed-in user, with an audit record in one transaction.
5. Remove `INITIAL_SETUP_KEY` from the environment after setup.

The first creation request reserves the initial account email. If a reservation exists,
only that account can complete setup. Account creation stops after an organisation exists.
Repeating creation for an already completed reservation returns the existing identity and
does not change its password. If the email already exists in Supabase, sign in with its
existing password and complete setup; the endpoint does not reset passwords.

A fixed setup marker and transactions prevent concurrent requests creating multiple initial
organisations. The final active administrator cannot be demoted or suspended, even under
concurrent requests.

## API contract for the frontend

All routes below require a verified Supabase bearer token. Identifiers are UUID strings;
MongoDB internal `_id` values are omitted from responses. Existing snake_case record fields
are preserved for frontend compatibility.

- `GET /api/auth/me` (alias `/api/context`): `{ user, memberships, sites, needsInitialSetup }`.
  Each site includes `roles`, `role` (legacy primary role), and `permissions`.
- `POST /api/setup`: first-dealership setup; returns `{ setup: { organisation_id, site_id } }`.
- `POST /api/auth/initial-user`: the exception to bearer authentication, protected by
  `setupKey` and an empty installation; body `email`, `password`, optional `fullName`,
  `setupKey`; returns `{ user: { id, email }, created, nextStep }`.
- `POST /api/admin/users`: ADMIN-only direct creation; body `organisationId`, `siteId` (required for SALES/SERVICE; null for ADMIN), `email`, `password`, optional `fullName`, `roles` (ADMIN/SALES/SERVICE array).
  Returns `{ user: { id, email }, memberships }`. Creates a confirmed Supabase identity,
  a MongoDB profile, active scoped memberships, and an audit event. Sends no email.
  ADMIN requires organisation-wide scope. Passwords are never stored in MongoDB or returned.
- `GET /api/admin/memberships?organisationId=...`: `{ memberships }`.
- `PATCH /api/admin/memberships/:id`: body `organisationId` and one or more of
  `role`, `siteId`, `brandIds`, `status` (`active`/`suspended`), `extraPermissions`; returns `{ membership }`.
  Changing role must also provide its valid scope: null site for ADMIN, explicit site for staff.
  Last-admin protection still applies.
- `GET /api/admin/invitations?organisationId=...`: `{ invitations }`.
- `POST /api/admin/invitations`: body `organisationId`, `siteId` (required for SALES/SERVICE), `email`,
  `roles`; returns `{ invitation }`. Creates an application invitation only; does not send email.
- `POST /api/admin/invitations/:id/send`: body `organisationId`; returns
  `{ invitationId, sent, message }`. Uses Supabase Auth email delivery.
  Existing Supabase users may sign in and accept even if the invite email fails.
- `POST /api/admin/invitations/:id/revoke`: body `organisationId`; returns `{ invitation }`.
- `GET /api/auth/invitations`: pending, unexpired invitations matching the verified email.
- `POST /api/auth/invitations/:id/accept`: returns `{ memberships }`.
  Requires matching confirmed email, pending status, and an unexpired invitation.
  Acceptance is atomic and cannot reactivate suspended memberships.
- `GET /api/admin/audit?organisationId=...`: paginated `{ events, pagination }`.
- `GET /api/customers?siteId=...&search=...`: paginated `{ customers, pagination }`.
- `POST /api/customers`: body `siteId`, `firstName`, `lastName`, `email` and/or `phone`;
  requires `Idempotency-Key` and returns HTTP 202 `{ command, replayed, integration }`.
  Poll `/api/integration/commands/:id`; use `customer.id` only after confirmed success.
- `GET /api/tasks?siteId=...&through=...`: `{ tasks }` due through the given date
  (default now), with customer name context.
- `POST /api/tasks`: body `siteId`, `customerId`, `title`, optional `details`, `dueAt`,
  optional `priority` (`low`/`normal`/`high`); returns `{ task }`, assigned to the creator.
- `PATCH /api/tasks/:id/complete?siteId=...`: returns `{ task }`.

Errors: 400 invalid request/unavailable invitation or task; 401 invalid identity; 403 missing
access; 404 unavailable administrative target; 409 duplicate or conflicting access change;
503 unavailable transactional operation. Successful POST requests normally return 201.
No frontend business-data writes should go directly to Supabase.

Supabase account creation and MongoDB persistence cannot share a transaction. An existing
Supabase email returns 409 without changing its password or granting new roles. Grant such
an account access through an application invitation. If Supabase creation succeeds but
MongoDB access cannot be confirmed, the route returns 503 with
`code: USER_PROVISIONING_INCOMPLETE` and `userId`. Check memberships first, then use an
invitation if access is missing. The backend never deletes an identity on an ambiguous result.
For initial creation, the reserved email can sign in and complete setup after a partial failure.

## Pentana preparation

Customer records have permanent internal UUIDs, `source`, and `external_ids.pentana`.
A partial unique index prevents duplicate Pentana customer IDs within an organisation.
Customer command processing, development simulation, and scraping-runner read/write
boundaries are implemented. The actual Pentana browser scraper, stock, deals,
appointments, repair orders, messaging, and CSV import remain subsequent work.

## Verification

- `pnpm build`
- `pnpm lint`
- `pnpm test`: token validation and current membership authorization unit tests.
- `pnpm test:e2e`: unauthenticated and forbidden endpoint boundaries.
- `pnpm test:integration`: real temporary MongoDB replica set; checks bootstrap races,
  last-admin protection, invitations, site isolation, task ownership, suspension, and audits.

The integration test downloads a MongoDB binary on its first run and stops its temporary
replica set afterward. Supabase identity is mocked in these database integration tests;
real Supabase sign-in and email delivery require configured credentials and a smoke test.

## Site and brand administration

ADMIN-only routes (all require organisationId):

- GET /api/admin/sites: paginated sites.
- POST /api/admin/sites: name, optional timezone (default Australia/Sydney), optional brandIds (default empty).
- PATCH /api/admin/sites/:id: name, timezone, and/or brandIds. The brand array replaces the complete mapping; [] removes all mappings.
- GET /api/admin/brands: paginated organisation brands.
- POST /api/admin/brands: name.
- PATCH /api/admin/brands/:id: name.

Site/brand names are trimmed, 2–120 characters, and unique within the organisation
using exact, case-sensitive matching. Sites validate IANA timezones. All changes
are transactional, recheck current ADMIN authority, and record before/after audits.
Brands mapped to a site must belong to that organisation. There are no delete routes.

Staff routes:

- GET /api/sites/:id/brands: paginated accessible brands and their permissions.
- GET /api/sites/:siteId/brands/:brandId: accessible brand detail and permissions.
- GET /api/auth/me (also /api/context): each accessible site includes a brands array with per-brand roles and permissions.

Direct user creation, invitation creation, and membership PATCH accept brandIds.
For staff, omitted/null means all brands mapped to their assigned site; a nonempty
UUID array restricts that membership to the specified mapped brands. Empty
restriction arrays are rejected. ADMIN remains organisation-wide and cannot have
brand restrictions. Membership PATCH preserves existing restrictions when omitted;
use explicit null to remove them. Invitations revalidate the current mapping at
acceptance and do not overwrite an existing membership's restrictions.

Unmapping a brand removes access immediately. Existing restricted memberships
remain recorded, so remapping restores their brand access; an ADMIN must update
those memberships explicitly if permanent revocation is intended. A pending
invitation whose brand was unmapped cannot be accepted until corrected by a new
invitation or valid mapping. Rejected acceptance rolls back atomically.

Customers and current general follow-ups remain shared at their authorised site.
This is the current site-neutral identity policy, not brand isolation of customer
records. Future brand-owned Sales/Service records must use AccessService.requireBrand
with their persisted site/brand and the action permission; site permission alone
must not authorize a brand-owned operation. Role permissions from different brands
are never combined by that check. The frontend should use each brand's permissions
for brand-specific controls rather than the site's combined permissions.

Legacy SALES/SERVICE memberships with null site remain in the administrator list,
but grant no site access and appear as no accessible sites. Correct explicitly
through membership PATCH; there is no automatic live-data migration.

## List pagination

Customer, task, membership, audit, invitation (including recipient), site, brand,
and accessible-brand lists accept offset (default 0, maximum 1000000) and limit
(default 100, range 1–100). Existing response array names are retained; pagination
adds offset, limit, hasMore, and nextOffset (null at the end). Use nextOffset for
the next request. Sorting includes the record ID to disambiguate equal values.
Offset pagination is not a snapshot: concurrent inserts/updates can shift later
pages. Context remains a full access summary rather than a paginated directory.

## Integration command architecture (Step 2)

Customer creation now queues a source write: POST /api/customers requires an
Idempotency-Key header and returns HTTP 202 with command, replayed, and integration
metadata. It no longer creates a local customer directly or returns immediate 201.
Poll GET /api/integration/commands/:id and use customer.id only after succeeded.
Tasks remain application-owned. Existing auth, invitations, and site permissions
are retained.

Configure INTEGRATION_MODE explicitly: disabled (default), simulated (development
opt-in only), or scraping. Scraping writes require INTEGRATION_WRITES_ENABLED=true;
an external runner claims writes, maintains its lease, and reports verified outcomes.
No actual Pentana scraper or credentials are supplied by this backend. Customer read
imports and create commands are implemented; normalized future entity contracts are
provisional. See INTEGRATION-RUNNER.md for the routes, schemas, and recovery protocol.

Commands, attempts, simulator receipts, retry schedules, and leases persist in
MongoDB. Definite non-application retries are bounded; uncertain scraping outcomes
require review. Source projections update only on confirmed results or verified read
imports. Simulation cannot start in NODE_ENV=production and its data is excluded
from scraping/disabled CRM lists. ADMIN attempt audits contain normalized contact
requests/responses; keep external credentials/HTML/screenshots out of these bodies.

## Customer 360 profile

GET /api/customers/:id?siteId=...&offset=0&limit=10 returns customer, site,
assignee (id/fullName only), tasks, pagination, taskVisibility (own/team/none),
permissions.canCreateFollowUp, and integration metadata. Paging applies to linked
follow-ups. Customers remain shared at the authorised site; task assignment/team
permission determines which tasks are returned. Other-site or other-mode IDs are
unavailable, and current suspended memberships cannot read the profile.

In the portal, click a customer name to open its profile and linked follow-ups.
Customer creation now shows pending source confirmation and a Check status action.
With simulation worker disabled for deterministic Postman tests, process that
command via the ADMIN simulator endpoint before checking status. The profile does
not yet include the activity timeline, notes, calls, vehicles, or editing.

## Customer 360 activity history (backend)

GET /api/customers/:id/activity?siteId=...&offset=0&limit=10 returns customerId,
activities, pagination, taskVisibility, and integration metadata. Each activity has
id, type, summary, occurredAt, author (id/fullName only), and optional taskId.
It exposes confirmed customer creation, meaningful source imports/refreshes, and
follow-up creation/completion. It does not expose raw audit metadata, staff emails,
source request bodies, lease tokens, or administrator diagnostics.

Customer events are shared at the authorised site. Follow-up events are filtered by
CURRENT task assignment and tasks.read/tasks.view_team permissions before pagination.
Unknown, other-site, or other-mode customers are unavailable. New source-import/
refresh events are written in the same transaction as the projection; repeated or
stale unchanged observations produce no extra activity. Earlier imports that only
recorded a site-level sync audit cannot be reconstructed as per-customer history.
This route reads retained local audit events; source-only historical records are
not scraped or fabricated. Notes/calls and customer editing are subsequent increments.

## My Day backend

GET /api/my-day?siteId=...&view=own&bucket=all&date=2026-10-12&offset=0&limit=10
returns the site-local day window, queue items with customer names, totals, paging,
view/bucket, team-access capability, and integration labels. date defaults to today
in the site's timezone; civil-day boundaries handle daylight-saving changes.

view defaults to own for EVERY role, including ADMIN. view=team requires current
tasks.view_team permission and never widens access beyond the selected site.
bucket accepts all, overdue, today, or calls. Open work due before the start of the
selected day is overdue; work within that day is today. Work due at/after the next
local day, completed/cancelled work, orphaned customer links, and other integration
modes are excluded. Totals count the full authorised queue before page/bucket
filtering. scheduledCalls is a subset of overdue/today, not an additional count to
add to all. Item order is due_at then ID; offset pages are not a snapshot across
separate requests.

POST /api/tasks accepts optional kind=follow_up (default) or call. A call task
schedules work only: it neither places a call nor records an actual call outcome,
consent decision, or customer message. Existing tasks without kind remain ordinary
follow-ups. Task editing/reassignment/rescheduling/cancellation APIs are now available;
see CUSTOMER-360.md. My Day excludes cancelled work and shows contact restrictions.
Appointments, deliveries, collections, and service/sales work are future queue inputs.

## Internal notes and recorded customer calls

POST /api/customers/:id/notes requires an authenticated site user with
customers.read/customers.write, Idempotency-Key (8–200 characters), siteId and text
(1–5000 trimmed characters). Notes are append-only, application-owned and shared
with customer readers at that site. They do not change source/customer contact
fields, send messages, or write to Pentana.

POST /api/customers/:id/calls accepts siteId, summary (1–5000), direction
(incoming/outgoing), outcome (connected/no_answer/voicemail/busy/wrong_number), and
optional occurredAt. Omitted time is recorded as now; valid historical timestamps
are accepted and future call times beyond 60 seconds clock tolerance rejected.
This endpoint logs an actual/attempted call; it does NOT dial a number or authorize
contact under consent rules. Recording a preference in text is not a consent
or privacy-field update.

Optional followUp: { title, dueAt, priority } creates a call task assigned to the
recorder, requiring tasks.write. Task, call entry, and audit events commit together.
The due date may be a historical overdue promise or a future callback. No implicit
completion of an earlier scheduled call task occurs. Use the existing complete
endpoint separately if applicable; automatic linkage/completion is future work.

Both write routes return HTTP 201 with entry, followUp (or null), replayed, and
integration metadata. Reusing the key with the same normalized request returns the
same entry/task; changed request/customer/site/kind/mode under that user's organisation
key returns 409. Retain keys and stable promise due dates on retries. Occurrence time
omission is normalized as null for the hash, so delayed retries remain identical.

GET /api/customers/:id/journal?siteId=...&offset=0&limit=10 lists site-shared entries
by actual occurrence time, then ID. Internal request hash/key fields are excluded.
A follow_up_task_id is shown only when the current user can read that specific task
under ownership/team rules; shared call text/outcome remains visible independently.
Entries include created_by, occurred_at, and created_at; the shared activity endpoint
adds readable authors and note/call content. Its occurredAt is the real event time
and recordedAt records when the event was logged, including backdated calls.
Timeline ordering now follows occurrence time with ID as tie-breaker.

Customer/site/organisation/mode checks and current memberships apply to all routes.
Notes/calls are stored in customer_journal with unique idempotency and history indexes.
No edit/delete routes, external call provider, or historical Pentana call import are
implemented in this increment. Treat note/summary content as plain text in consumers.

## Step 3: customer edits, consent, task management and SMTP email

See [CUSTOMER-360.md](CUSTOMER-360.md) for current routes, permissions, command states,
SMTP configuration and Postman simulation. Contact/privacy updates are confirmed
by the source, task changes use versions, and email requires an explicit send with
confirmed consent. SMTP is configurable email transport; SMS needs a separate
provider. Live SMTP remains unconfigured/unverified. Real Pentana/eraPower scraping
stays last; frontend files are outside this implementation.

Frontend integration is now connected through Step 3; see
[FRONTEND-INTEGRATION.md](../my-app/FRONTEND-INTEGRATION.md). The newer implementation
plan section supersedes the earlier backend-only status. For local Atlas DNS failures,
the optional `pnpm run start:local:dns` runs the compiled backend with a process-only
resolver workaround, retaining TLS and refusing production mode. Normal start commands
remain available; build the backend before using this local fallback.
