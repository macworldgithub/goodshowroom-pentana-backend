# Stock reservations — Step 4, sixth part

Reservations are local operational holds against an approved deal, not payments, purchase agreements or Pentana reservations. Real source write-back remains the final integration step.

## Rules

A current approved deal, open enquiry, available vehicle and unchanged approved stock/appraisal snapshots are required. Sales write access, current enquiry ownership (or sales.view_team) and current brand access apply. SERVICE alone is denied.

Expiry must be in the future and at most seven days away. One active reservation is allowed per vehicle across proposals. A partial unique MongoDB index and transactional stock/deal locks protect simultaneous requests. Reusing the same Idempotency-Key and payload returns the same reservation, including after it ends; changed payload/key reuse returns 409.

Reservations can be released with their current version and a reason. An approved deal's cancellation releases its active hold in the same transaction. A stale cancellation rolls back release. Release remains possible when an enquiry is closed; new holds require reopening.

Expiry is effective immediately in availability/active-hold reads. The backend checks expired holds before new reservation creation and runs a sweep every minute, up to 100 expired records per cycle. Expiry history is recorded as System. Expired records are retained; there is no TTL deletion. If the worker is temporarily down, availability and creation still enforce the expiry time.

Stock editing and linked appraisal changes are blocked while their reservation is active. Reserved stock cannot be added to new shortlists or another proposal. Existing shortlists remain advisory. After a hold ends, a fresh reservation may be created against a still-current approved proposal. Domain stock/deal versions do not change just because a hold was created/released; enquiry progress versions do.

## APIs

- GET /api/sales/leads/:leadId/deals/:dealId/reservations?siteId=...: paginated history and active hold. Active is calculated independently of the history page.
- POST /api/sales/leads/:leadId/deals/:dealId/reservations: Idempotency-Key required. Body: siteId, current dealVersion, expiresAt and note.
- PATCH /api/sales/leads/:leadId/deals/:dealId/reservations/:id/release: siteId, current reservation version and note.

Stock list/detail includes availability and a safe reservation summary with expiry only, without customer/deal identity. The status=available filter excludes active holds before pagination; status=reserved selects them. No source-owned availability flag is overwritten. Deal lists show their own reservation expiry.

## Frontend / Postman

Open Sales desk → Deals → Reservation. The approved-deal reservation form defaults to 24 hours and labels date input in the device timezone. Reads display site timezone. The modal refreshes every 15 seconds; Stock match and deal lists offer Refresh. Use Reserved or All availability in Stock match to view held vehicles. The original sidebars are retained.

Postman folder **30 Stock reservations** follows folder 29. It captures current approval version, creates a 24-hour hold, checks stock/history/permissions, verifies stale-release denial and releases its test hold. The collection has 30 folders and 231 requests. Local private settings are retained.

Verification: 60 MongoDB integration tests, 4 endpoint tests, 99 backend unit tests and 8 frontend form/transport tests passed, plus backend build/lint, frontend production build/typecheck/lint and Postman script/scope checks. Reservation tests cover competing holds, expiry before worker persistence, worker idempotency, linked appraisal protection, cancellation rollback, current-owner access and absence of customer disclosure in stock summaries. Signed-in browser walkthrough remains pending.

Next: delivery checklists, then full Sales workflow verification. This increment does not complete Step 4 on its own.
