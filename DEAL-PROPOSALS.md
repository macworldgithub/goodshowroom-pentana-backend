# Deal proposals — Step 4, fifth part

This increment records internal Sales proposals. It does not sign an agreement, charge a customer, acquire a trade-in, reserve stock, close the enquiry or send a Pentana command. Reservations and delivery are separate upcoming increments; real scraping remains last.

## Workflow and calculation

Sales desk → Deals opens the enquiry's proposal register. Select an available site vehicle and optionally a currently Valued appraisal from the same enquiry. The vehicle, customer, enquiry, site and brand links are fixed after creation. The appraisal can be replaced/removed when pricing is edited.

The server calculates integer-cent AUD pricing:

`net total = sale price - discount + fees - trade-in credit`

The trade-in credit comes from the selected appraisal; arbitrary credits and client-supplied totals are rejected. All entered monetary values must be nonnegative integer cents, at most 1,000,000,000 per input. Discounts cannot exceed sale price. Negative net proposals are rejected; zero totals are allowed. Fees are entered manually; tax, finance, loan settlement and statutory fee calculations are not included.

States:

- Draft: Sales can edit pricing and source snapshots.
- Submitted: awaits Admin review; pricing cannot be edited.
- Approved: Admin-approved internal proposal; does not guarantee availability or reserve the vehicle.
- Rejected: Sales can edit it, returning it to Draft, then submit again.
- Cancelled: terminal. Create another proposal if needed.

Every status action requires a note. Admin's sales.approve_deals permission is required to approve/reject and to cancel an Approved proposal. Sales may cancel their Draft/Submitted/Rejected proposals. Admin can review internally prepared proposals, including their own. Current enquiry ownership or sales.view_team controls access; current mapped-brand access controls deal reads and history. An enquiry supports at most 20 proposals, including cancelled ones.

Stock and appraisal versions are copied into the proposal. Submission and approval recheck availability, appraisal status/value and snapshot versions. If something changed, a Draft must be edited to refresh it; a Submitted proposal must first be rejected/cancelled. Snapshot checks serialize with stock/appraisal edits. After approval these remain historical snapshots; later reservation/finalisation must revalidate them.

Closed enquiries allow reading but require reopening for creation/editing/submission/approval. Rejection/cancellation can still resolve outstanding internal proposals. Proposal changes increment the enquiry version and write a progress entry in the same transaction. Enquiry stage and follow-ups are not automatically changed.

## API

- POST /api/sales/leads/:leadId/deals: Idempotency-Key required. siteId, stockId, salePriceCents and notes required. Optional appraisalId (or null), discountCents and feesCents. Creation is Draft. Same key/payload returns the current proposal; changed payload/key reuse returns 409.
- GET /api/sales/leads/:leadId/deals?siteId=...: offset/limit pagination with current brand scope applied before pagination.
- GET /api/sales/leads/:leadId/deals/:id?siteId=...: scoped detail.
- PATCH /api/sales/leads/:leadId/deals/:id: siteId, current version, appraisalId (nullable), salePriceCents, discountCents, feesCents and notes. Only Draft/Rejected can be edited.
- PATCH /api/sales/leads/:leadId/deals/:id/status: siteId, current version, action (submit/approve/reject/cancel) and note. Stale versions or invalid transitions return 409.

SALES read/write applies; SERVICE alone is denied. Proposal ownership follows current enquiry assignment, not the creator. Pipeline progress history includes authors, timestamps, review notes, vehicle label, status and total snapshots. Deal events disappear from the caller's history when their brand access is removed.

## Testing

Postman **29 Deal proposals and approval** follows folders 25, 27 and 28: open enquiry, available simulated stock, valued appraisal. It creates/reads/submits a proposal, verifies Sales approval denial, approves as Admin and reads progress. The collection now contains 29 folders and 222 requests; local private settings are preserved.

Checks passed: 59 MongoDB integration tests, 4 endpoint tests, 99 backend unit tests, 8 frontend transport/form tests, Postman script/scope checks, backend build/lint and frontend production build/typecheck/lint. Tests cover server-calculated totals, stale stock/appraisals, invalid edits, permissions, reassignment/brand restrictions and simultaneous Admin decisions. Signed-in browser walkthrough remains pending.

Next: stock reservations, followed by delivery checklists and full Sales workflow verification.
