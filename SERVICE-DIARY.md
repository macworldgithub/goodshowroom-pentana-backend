# Service diary and workshop capacity

The existing Service Desk now contains a site-local daily diary, workshop resource
management, available slots and the booking register. Existing sidebars are retained.

## Resources and bookings

ADMIN creates/edits resources through service.resources_manage. Each resource has
capacity for one appointment at a time, configured weekdays (Sunday=0), opening
and closing minutes on 15-minute boundaries, and an active flag. Multiple bays
are separate resources. Hours use the site's timezone; no overnight opening period
or holiday override is configured in this increment.

New bookings require resourceId. Times use 15-minute boundaries within the bay's
hours. The existing 15-minute to 8-hour duration and 365-day booking horizon apply.
Changing times or resource returns the booking to booked. Adjacent intervals can
share an endpoint. Booked and confirmed appointments occupy capacity; cancellation
or attendance/no-show releases it. Attended does not mean a bay is occupied by a
repair order: repair orders and actual workshop check-in are the next increment.

Booking, moving and releasing a resource update its transaction lock. Concurrent
overlap attempts therefore serialize: one succeeds and the other returns 409.
Capacity covers all owners, brands and integration modes because the bay is shared.
Availability reveals free slots, without exposing other appointments or customers.
A displayed slot is advisory; saving rechecks it.

Resource edits cannot deactivate a bay or narrow its hours around future/current
active bookings. Reschedule or close those bookings first. Resources are retained
rather than deleted. Creation supports Idempotency-Key; edits require version.

Existing appointments without resource_id remain visible and show “Needs resource”.
Assign a bay before confirming/rescheduling; no resource assignment or data migration
was invented for old bookings.

## Diary and My Day

GET /service/diary accepts siteId, date (YYYY-MM-DD in the site timezone), view
(own/team), optional resourceId and pagination. It includes bookings overlapping
the day, including midnight-spanning legacy bookings and closed status history.

GET /service/my-day returns open booked/confirmed appointments through the selected
day, with all/today/overdue filters and counts over the full authorized queue.
Earlier unresolved bookings remain overdue until an outcome is recorded.
Appointment rows with missing or incompatible customer/source records are excluded.

SERVICE sees its assigned appointments; service.view_team enables team rows within
current site/brand access. Team Service permission is independent of tasks.view_team.
The frontend My Day displays separate task and Service queues with separate counts,
pagination and team selectors. The existing /my-day API keeps its task-only contract.

GET /service/resources lists resources. POST /service/resources and
PATCH /service/resources/:id manage configuration. GET /service/availability accepts
siteId, resourceId, date, durationMinutes (15–480, in increments of 15), and pagination.
Local day boundaries and slot checks handle daylight-saving transitions.

## Postman and verification

Folder 32 now creates a disposable bay and supplies resourceId for its bookings.
Folder 33 verifies capacity conflicts, diary/My Day visibility, active-booking
deactivation protection and cancellation restoring a slot. Run against disposable
fixtures with valid ADMIN/SERVICE accounts and a mapped accessible brand. Default
team-denial checks assume SERVICE has no service.view_team grant.

Collection: 33 folders, 269 requests. Private credentials were preserved; scripts
parse and five variable-scope checks pass. Live Postman requests were not rerun.

63 MongoDB integration tests, 107 backend unit tests, 4 endpoint tests and 10
frontend tests pass. Checks include concurrent booking, failed-reschedule rollback,
adjacent slots, cross-brand capacity/privacy, independent team permissions,
legacy/unallocated midnight bookings, deactivation, local hours and DST.
Backend build/lint and frontend type/lint/build checks pass.

Signed-in browser acceptance remains pending because the browser tool cannot
initialize on this machine. No customer notification or real source write occurred.
Next: repair orders, followed by check-in/collection, customer updates and recovery
queues. Real Pentana/eraPower scraping and write-back remain the final stage.

