# Service appointments — first Step 5 increment

Update: diary/capacity and appointment My Day queues are now implemented. New
bookings require resourceId; legacy bookings need a bay before confirmation or
rescheduling. See [SERVICE-DIARY.md](SERVICE-DIARY.md) for the current contract and
verification; the original increment description below is retained for context.

Backend and frontend support local customer-linked bookings with site/brand access,
advisor assignment, paginated status/customer/time-range reads, confirmation,
rescheduling, editing, cancellation and attended/no-show outcomes.

SERVICE sees its own assigned bookings; service.view_team enables team visibility.
Reassignment requires service.assign_work and an active advisor with Service access
to the booking's site and brand. ADMIN has team and assignment permissions. SALES
cannot access Service appointments by default. Brand/customer/site/source identity
cannot be changed through edits; create a new booking when these need changing.

Creation requires Idempotency-Key; reuse the identical body/key for safe retries.
Edits require the current version. Times include a timezone and last 15 minutes to
8 hours. Create/reschedule within the next 365 days. Rescheduling returns confirmed
appointments to booked. Cancellation and attendance/no-show require an outcome note.
Attendance cannot be recorded before the start. Closed bookings remain in history
and cannot be edited. Confirmation records a local status, not a notification.

API: GET/POST /service/appointments; GET/PATCH /service/appointments/:id.
List parameters: siteId, optional status/customerId/from/to/offset/limit. from is
inclusive and to exclusive on the appointment start. Vehicle is descriptive text;
the customer vehicle register and source vehicle mappings are separate later work.

Frontend: existing Service Desk (/service), with booking cards and edit/outcome
dialogs. Times display in the site timezone; input uses the device timezone.
Appointment events appear in Customer 360 with authors/timestamps only while the
reader retains Service ownership/team and brand access. Internal notes are not
exposed through raw audit metadata.

Postman folder 32 selects an accessible Service brand and exercises booking,
confirmation, stale edits, rescheduling, history and cancellation. Use a disposable
serviceCustomerId from the SERVICE customer workflow. Collection: 32 folders,
256 requests; private credentials preserved. Live requests were not rerun.

Verification: 62 MongoDB integration, 103 unit, 4 endpoint and 9 frontend tests
passed. Builds, lint/type checks and Postman script syntax/scope checks passed.
Signed-in browser acceptance is pending because the browser tool cannot initialize.

Next increment: site-local daily diary, workshop capacity/resources, appointment
inputs in My Day. Repair orders, operational check-in/collection, customer updates
and recovery queues follow separately. These bookings do not allocate bays or
prevent overlapping appointments. Real Pentana/eraPower scraping/write-back stays
in the final integration stage. No customer message or source write was submitted.

