# Local/simulated scope review - 16 October 2026

The current user request authorises review and implementation of the remaining
local/simulated scope. It explicitly excludes real Pentana/eraPower connections and
live data. The supplied prompt and scope are requirements to compare against;
their live-integration instructions do not override that restriction.

**The full Markdown scope is not complete.** Its dealer-authorised integration,
production deployment and pilot acceptance gates require external work which is
intentionally deferred. The operating workflows below are implemented locally;
signed-in browser acceptance is still pending. Automated tests do not replace that
acceptance or prove a live source write.

| Requirement | Current implementation | Acceptance / external remainder |
| --- | --- | --- |
| Foundation and access | Existing authentication, setup, invitations, staff, sites/brands, assignment and pagination retained. Added `reports.read` and `reports.view_group` as extra grants without new login roles. | Dealer SSO and production identity configuration. |
| Customer 360 | Site/mode-checked, paginated vehicles and household/company links; simulated fixture creation restricted to ADMIN. Owned/previous ownership, VIN/registration, next service and campaigns can be represented. Known sites are returned without inventing cross-site history. | Complete source-backed relationships, vehicles and sites-dealt-with require actual authorised reads. |
| Shared timeline | All/Sales/Service/Messages/Tasks filters, ascending/descending order, notes/calls, task/message outcomes, sales stages, appointment and RO events including check-in/collection. Sales events retain current assignment and brand restrictions. | Historical/source-only events are not fabricated. |
| Activity mirroring | Durable simulated activity queue for internal notes, recorded calls, stage-change notes and message outcomes; receipts, retry limits, uncertain outcomes and reviewed ADMIN retries. Public status excludes raw request bodies. | Real activity mapping/write acceptance. |
| My Day | Existing tasks/calls and independent Service appointment/RO queues retained; ready collections, authority/parts exceptions, RO follow-ups and handover risks added. | Signed-in role/site walkthrough and live working-day acceptance. |
| Sales | Existing enquiries, internal proposals/appraisals and reservations retained. Scope stage names and incoming stock projection added alongside legacy stages. Stage moves now create a real internal thread note. Order creates Service-visible handover preparation and a task. | Local proposal approval is not proof of a source quote/order or accepted commercial changes. Dealer-approved source stage/field mapping is deferred. |
| Bookings and diary | Day/week diary with authorised advisor filtering. Existing local slots, bays, hours and conflict checks preserved. Diary exposes arrived/in-progress/ready/collected from authorised linked ROs. | Actual source capacity acceptance is not simulated as live proof. |
| Repair orders | Appointment/customer/site/brand/advisor links, optional simulated customer-vehicle link, list/detail/board, authority/status history and durable commands. | Source RO creation is not invented. Actual source RO import/mapping is deferred. |
| Check-in/workshop | Validated arrival, odometer/fuel, acknowledgment, atomic simulated loan-car allocation, technician status/road tests, waiting parts, promised-time changes, overrun flags and reassignment with current grants. | Source-supported loading/loan-car capabilities and pilot process sign-off. |
| Authority/operations | Pending/approved/declined decisions with evidence. A decline keeps work waiting for authority. Source-style simulated operation addition requires approval and has no local prices or totals. | Actual operation codes and accepted source writes. |
| Collection | Ready-state/road-test checks, explicit key/vehicle handover and loan return, timestamps/staff and timeline. Collection never changes invoice/payment fields. | Real financial context remains read-only and unavailable until imported. |
| Customer updates | RO-linked email/SMS drafts; human review and separate explicit send; current consent, pending privacy changes and duplicate-send protection. SMS has an opt-in development simulator only. Accepted transport and delivery evidence remain distinct. | Live SMS provider and live email acceptance/delivery are intentionally untested. |
| Recovery | Paginated unconfirmed/missed/no-show bookings, unanswered calls, authority, missed promises and declined-work prompts; persisted resolutions/history and optional assigned follow-ups. New source versions resurface work. | Dealer recovery rules and signed-in acceptance. |
| Handover | Extends existing delivery preparation: versioned PDI/ownership/due dates and tasks, accessories, contact preferences, capacity-checked first service, final handover and risk queues. Cancelled first-service bookings remain a risk and may be rebooked. | Dealer handover/PDI process acceptance. No stock sale or financial posting is implied. |
| Cross-desk/group reporting | Service sees sanitised open sales opportunities for authorised checked-in customers. Operational counts span explicitly authorised report sites/brands, including parts/authority, overdue jobs, deliveries/collections and handover risks. Invented scores/trends and financial totals removed. | Dealer manager grants and operational acceptance. |
| Assistance | Last-three-readable-event context, editable local reply templates, next-action rules and missed-promise flags. Provider availability is explicit; no automatic customer sending. | A real AI provider is not configured. These templates are not represented as model-generated output. |
| Refresh/reconciliation | Open customer/diary/pipeline views refresh local projections while visible. Customer simulator reconciles accepted receipts hourly and records conflicts. RO simulator acceptance is transactional with its projection. | Reconciliation/read-after-write for real entities and transport remains deferred. |
| Audit/operations | Non-expiring audit records, configurable minimum retention of 7-100 years and paginated ADMIN audit export. Readiness endpoint identifies Australian residency, external secrets store, SSO and provider dependencies. | Production retention/backup guarantees, Australian hosting, secrets-store deployment and SSO are not verified. |

## Source ownership

Pentana remains the intended owner of customer master, vehicles/stock, commercial
records, appointments, RO operations and financial context. Local fixtures and
receipts are labelled simulated. Tasks, unsent drafts, recovery resolutions and
handover checklists are application-owned. There is no new financial engine,
payment processing, parts inventory, technician clocking or automatic messaging.

Customer contact/privacy, RO actions and activity mirrors have durable queues.
The older Sales/booking implementation still represents local operations; it must
be routed through confirmed source capabilities before live rollout. No generic
public Pentana API, browser selectors or real status codes are fabricated here.
The live ownership matrix must be approved by the dealer administrator.

## Configuration and persistence

- Restart the backend to apply MongoDB indexes and start workers. No SQL migration.
- Existing simulator settings are reused: `INTEGRATION_MODE=simulated`,
  `ALLOW_SIMULATED_INTEGRATION=true`, `INTEGRATION_WORKER_ENABLED=true` and
  `MESSAGE_TRANSPORT=simulated` for local message acceptance.
- `AUDIT_RETENTION_YEARS` defaults to 7 and rejects values below 7. It is policy
  metadata; the application does not automatically delete audits or establish a
  production archival guarantee.
- New collections: repair orders/commands, simulated activity commands/receipts,
  recovery resolutions, customer vehicle/relationship fixtures, loan-car fixtures
  and application-owned handover items. Existing collections are preserved.
- Actual environment files and credentials are not exported or committed.

## Verification and remaining gates

Postman contains **38 folders / 345 requests**. New optional folders cover the
simulated workshop day, handover/reporting, customer context and activity mirroring.
Scripts parse and the five variable-scope checks pass. These are not live Postman
results. Some examples require explicitly selected disposable started bookings,
current versions and appropriate command states; follow each folder's description.

Automated coverage uses temporary MongoDB replica sets and a test identity guard.
It covers current access, versions, authority/road tests, check-in/loan return,
collection without invoicing, linked/consent-blocked SMS, duplicate sends,
recovery/tasks, order-to-handover/first-service capacity, reporting isolation,
activity receipts/review and reconciliation conflicts. A five-read local warm API
test checks the two-second profile target; it excludes browser rendering,
production networking and live source latency.

See `SCOPE-PROGRESS.md` for final check results. Still pending:

1. Signed-in browser Sales and Service day walkthroughs and actual Postman runs.
2. A dealer-authorised pilot site/brand, supported integration path and signed
   field/status ownership mappings, then real read and verified write proof.
3. Provider-specific SMS/email delivery and AI configuration when live work is
   authorised. No real customer messages were sent by this review.
4. Australian hosting/data residency, production secrets/SSO, retention/backup
   configuration and production performance/availability acceptance.

There is no request to connect those external dependencies in this local phase.
