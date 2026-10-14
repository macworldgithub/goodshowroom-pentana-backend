# Sales enquiries — Step 4, first part

Sales enquiries are local CRM records linked to a confirmed customer at the same site and in the current integration mode. Real Pentana scraping is deferred.

## APIs

- `POST /api/sales/leads`: requires an Idempotency-Key (8–200 characters), siteId, customerId, title and source. Optional vehicleInterest, assignedTo and followUpAt. An identical retry returns the same enquiry; a changed payload with the same key returns 409.
- `GET /api/sales/leads?siteId=...`: paginated with offset/limit; optional status and title search. Sales staff see their assigned enquiries; sales.view_team permits site team visibility.
- `GET /api/sales/leads/:id?siteId=...`: same scope restrictions.
- `PATCH /api/sales/leads/:id`: siteId and current integer version required. Editable fields: title, source, vehicleInterest, status and assignedTo. Stale edits return 409. Customer/site cannot be changed.

Statuses are new, contacted, qualified and closed. Pipeline stages, won/lost deal outcomes, stock, appraisals and reservations are subsequent parts.

Sales read/write permissions are required. SERVICE alone has no access. Reassignment requires sales.assign_leads and active Sales write access for the recipient. Optional follow-up creation also requires task write permission; assigning that task to another person requires tasks.assign. Transactions keep the enquiry, initial task and audit records together.

An initial follow-up uses the existing task system and appears in My Day and the customer timeline. Manage its schedule, completion, cancellation and reassignment in Customer 360. Changing enquiry ownership does not automatically reassign an existing task.

The frontend Sales enquiries sidebar entry opens the connected register with filters and create/edit dialogs. Sidebar appearance and order are retained.

Postman folder **25 Sales enquiries** covers creation, listing, detail, qualification, admin team listing and SERVICE denial. Run login/context and customer creation/confirmation first. The folder saves salesLeadId and salesLeadVersion. Do not rerun creation to retry an uncertain write with a newly generated key: reuse the original key and payload.
