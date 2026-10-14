# Stock matching — Step 4, third part

This increment provides development stock and enquiry shortlists. Real stock ingestion/scraping, reservations and deals remain deferred. No stock commands are sent to Pentana.

## Stock register

Administrators can create and edit simulated vehicles only when INTEGRATION_MODE=simulated. Sales staff can read stock; SERVICE alone cannot. A vehicle belongs to one site and mapped brand, and reads/matches enforce current brand access. Site/brand cannot be changed after creation.

Records include stock number, make/model/variant, model year, odometer, optional VIN/colour, body/fuel/transmission, optional AUD price, availability and version. Price is stored in integer cents; unknown prices are excluded by maximum-price filtering. Stock numbers are unique within site/mode. VIN, if supplied, must have 17 letters/digits excluding I/O/Q. Availability is available, sold or unavailable. These are simulated stock states, not live dealer availability.

- POST /api/sales/stock: Idempotency-Key required; siteId, brandId, stockNumber, make, model, year, odometerKm, bodyType, fuelType and transmission required. Optional variant/vin/colour/priceCents. Identical retries reuse the vehicle; key reuse with changed data returns 409.
- GET /api/sales/stock?siteId=...: offset/limit pagination; optional search (stock number/make/model/variant/VIN), brandId, status, bodyType and maxPriceCents. Brand scope is applied before pagination.
- GET /api/sales/stock/:id?siteId=...: scoped vehicle detail.
- PATCH /api/sales/stock/:id: siteId, current version, all editable vehicle fields and status. Stale edits return 409. Creation requires stock.manage, which is granted to ADMIN only.

## Matching

PATCH /api/sales/leads/:id/stock accepts siteId, current enquiry version, stockId, action (add/remove) and note (3–1000 characters). It requires Sales write permission and own enquiry ownership, or sales.view_team. The vehicle must be in the same site/organisation/integration mode and an accessible brand.

Only available vehicles can be added to an open enquiry. Each enquiry supports at most 10 vehicles. Re-adding an existing match is rejected. Removed matches increment the enquiry version and leave an audit trail. Removal remains possible after a vehicle becomes sold/unavailable. Matching serializes with availability writes so a retried transaction rechecks status.

Shortlisting does not reserve a vehicle. Multiple enquiries may shortlist the same vehicle. Closing an enquiry does not modify its shortlist or follow-ups. Availability changes do not erase previous shortlists; the stock screen displays current availability. Reopen a closed enquiry before adding new matches.

Matching notes appear in Sales desk progress history with authors, timestamps and vehicle labels. Stock history entries are filtered by current mapped-brand access. Enquiry stock_ids are references; the stock register exposes only currently accessible vehicle details.

## Frontend / Postman testing

1. Sign in as ADMIN and map a brand to the site using Dealership settings. Ensure the Sales account has access to that brand.
2. In Stock match, add a simulated vehicle. Sales users cannot create/edit stock.
3. Sign in as SALES or ADMIN, choose an existing open enquiry, filter vehicles and shortlist one with a note.
4. Open Sales desk → Progress history to review the matching note. Use All availability to review shortlists where vehicles later became unavailable.

The original sidebars are retained. Postman folder **27 Stock matching** follows folders 25–26. It selects a Sales-accessible mapped brand, creates an admin simulated fixture, reads/filter stock, saves a shortlist and checks history/SERVICE denial. Missing brand mappings stop the workflow with an explicit diagnostic; the collection does not silently expand account access.

Verification: database integration suite (57 tests), endpoint suite (4 tests) and frontend transport/form suite (8 tests) passed. Backend build/lint and frontend typecheck/lint passed. Signed-in browser walkthrough remains pending.

Next: trade-in appraisals, then deals/reservations and delivery checklists. Real Pentana scraping stays last.
