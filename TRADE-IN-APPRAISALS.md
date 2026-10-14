# Trade-in appraisals — Step 4, fourth part

Local appraisals are linked to an existing enquiry and its customer/site/organisation/integration mode. These records capture internal vehicle assessments, not binding offers, financial deals, acquired stock or Pentana writes. Real scraping remains deferred.

## Workflow

Sales desk → Trade-in appraisals on an enquiry opens its appraisal register. Create a Draft with make, model, year, odometer and condition notes. Registration and VIN are optional. Edit / value records an internal AUD estimate and supporting notes.

- Draft: assessment in progress; valuation may be unset.
- Valued: requires a nonnegative integer-cent valuation and at least three characters of valuation notes. Zero is allowed and differs from an unknown value.
- Withdrawn: requires a withdrawal reason. The previous estimate may remain recorded but is labelled Withdrawn.

Statuses can be revised while the enquiry is open; changes remain in progress history. Closed enquiries allow reading/replaying previously accepted creation requests but require reopening for new appraisals or edits. No destructive appraisal deletion is provided. An enquiry can have at most 20 appraisals, including withdrawn records.

## APIs

- POST /api/sales/leads/:leadId/appraisals: siteId, make, model, year, odometerKm and conditionNotes required. Optional registration/vin. Idempotency-Key required (8–200 characters). Creates Draft with unknown valuation. A replay returns the current appraisal; changed payload/key reuse returns 409.
- GET /api/sales/leads/:leadId/appraisals?siteId=...: paginated offset/limit list.
- GET /api/sales/leads/:leadId/appraisals/:id?siteId=...: scoped detail.
- PATCH /api/sales/leads/:leadId/appraisals/:id: siteId, current appraisal version, all vehicle fields and status. Optional valuationCents/valuationNotes/withdrawalReason, subject to status requirements. Stale versions return 409.

Sales read/write and current enquiry ownership apply, or sales.view_team for team access. SERVICE alone is denied. Access follows current lead assignment, not the appraisal creator. Records cannot change enquiry/customer/site linkage. VIN validation excludes I/O/Q and requires 17 characters; year/odometer/valuation bounds are validated.

Transactions keep appraisal creation/editing, enquiry version increments and progress audit entries together. Concurrent updates commit only one assessment at a given version. Appraisal changes increment enquiry version: refresh it before a pipeline or shortlist edit.

Progress history includes author, timestamp, vehicle label, assessment status, valuation snapshot and valuation/withdrawal notes. Later edits do not replace the prior event's valuation snapshot. Legacy lead history is retained.

## Testing

Postman **28 Trade-in appraisals** follows enquiry creation in folder 25. It creates a draft, lists/reads it, values it, checks progress history and verifies SERVICE denial. The collection now contains 28 folders and 214 requests. Private environment credentials and connection settings are retained.

Database tests cover idempotency, validation, zero-valued estimates, concurrency, enquiry closure/reassignment and scoped reads. Frontend form tests verify object JSON submission, integer-cent amounts, version and retry-key preservation. Signed-in browser walkthrough remains pending.

Next: deals and reservations, followed by delivery checklists. Appraisal estimates will only affect deal figures when those later features explicitly link them.
