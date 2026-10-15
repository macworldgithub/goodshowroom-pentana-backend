# Delivery plans and readiness

Step 4 includes delivery scheduling and five checks: documents, payment verification,
vehicle preparation, customer confirmation and handover pack. Open Sales desk → Deals
→ Delivery plan or the existing Handover lane. Sidebars remain unchanged.

SALES manages accessible plans and documentation; SERVICE reads/prepares within its
site/brand access; ADMIN confirms payment evidence. Payment notes are hidden from
Sales/Service. This internal confirmation does not collect money.

Readiness requires a current approved deal, unchanged available stock/appraisal,
an active reservation covering the schedule, and all five checks. Edits validate
versions and current access; creation supports idempotent retries. Reopening a
cancelled plan resets checks. Plan cancellation retains the reservation; deal
cancellation atomically cancels the plan and releases its hold.

API: /sales/deliveries supports paginated list, detail, create, reschedule, checklist
updates and cancellation. Authenticate with a bearer token and provide siteId,
current version for edits, and Idempotency-Key for creation.

Postman folder 31 verifies a simulated approved fixture before sample mutations,
then tests role restrictions, readiness, history and loss of readiness on release.
Run preceding Sales folders in order. SERVICE needs matching site/brand access.
No real payment, customer message, source write or final handover occurs.

Verification: 61 MongoDB integration, 4 endpoint, 103 backend unit and 8 frontend
tests passed, plus builds/lint/type checking. Postman has 31 folders/245 requests;
script syntax and five scope checks passed. Live Postman requests were not rerun.
Signed-in Sales browser acceptance remains pending because the browser tool failed
to initialize. Step 4 implementation is complete for simulation/internal proposals.
Final handover/PDI/first-service booking remains Step 6; real scraping remains Step 7.

