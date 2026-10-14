# Sales pipeline — Step 4, second part

The Sales desk now tracks local CRM enquiry progress. Pentana scraping, financial deals, stock and reservations remain separate future increments.

## Workflow

Stages: New, Contacted, Qualified, Test drive, Negotiation, Won and Lost. Existing enquiries closed before this increment remain visible in Closed (existing). Existing records without pipeline_stage derive their stage from enquiry status; no destructive migration is needed.

Every dedicated stage move requires a progress note of 3–1000 characters. Backward moves and reopening are allowed with a note. Won is an enquiry outcome; it does not create a financial deal, reserve stock or submit a source write. Follow-up tasks are managed separately and are not completed/cancelled by closing an enquiry.

Legacy enquiry status remains new/contacted/qualified/closed. Test drive and Negotiation map to qualified; Won/Lost map to closed. Editing an unchanged enquiry status preserves an advanced pipeline stage. Changing legacy status changes the corresponding stage and records a generic enquiry update in history.

## API and access

- `GET /api/sales/pipeline?siteId=...&stage=...&search=...&offset=0&limit=20`: paginated enquiry register plus all-stage counts. Counts use the same authorised scope and title search as the list, before the selected stage filter and pagination.
- `PATCH /api/sales/pipeline/:id/stage`: siteId, current version, stage and reason. Version conflicts return 409. Same-stage moves are rejected. Concurrent moves commit only one stage change and one history event.
- `GET /api/sales/pipeline/:id/history?siteId=...&offset=0&limit=10`: paginated creation/edit/stage history, authors, timestamps, from/to stages, progress notes and revisions. Legacy history may lack stage details. Raw audit payloads and user email addresses are not exposed.

Sales read/write permissions apply. Sales users see their assigned enquiries; sales.view_team permits team visibility. SERVICE alone is denied. History is checked against current enquiry ownership, site, organisation and integration mode. Reassignment can remove the previous owner's ability to read it.

## Frontend and Postman

The original **Sales desk** sidebar entry opens the connected pipeline with stage count cards, search and stage filters, version-checked move dialogs and progress history. The sidebar layout is unchanged. Sales enquiries remains the create/edit location.

Postman folder **26 Sales pipeline and progress** follows folder 25. It reads the current version, moves to Test drive, reads history and verifies validation and role denial. Refresh current state before resubmitting an uncertain move; the history shows whether the first request was committed.

Verification: MongoDB integration suite (56 tests), endpoint suite (4 tests), frontend transport/form regression suite (8 tests), backend build/lint and frontend production build/typecheck/lint passed. Signed-in browser walkthrough remains pending; the available browser session did not contain a signed-in localhost:3000 session.
