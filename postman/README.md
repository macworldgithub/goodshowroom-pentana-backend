# Good Showroom Postman Tests

Reservations are in **30 Stock reservations**, following approved proposals in folder 29. The test hold is released at the end. See [reservation workflow and API details](../STOCK-RESERVATIONS.md).

Deal proposals and Admin approval are in **29 Deal proposals and approval**. Use an open enquiry, available stock and a Valued appraisal from folders 25, 27 and 28. See [proposal workflow and API details](../DEAL-PROPOSALS.md).

Trade-in appraisals are in **28 Trade-in appraisals**. Start with an open Sales enquiry. See [appraisal workflow and API details](../TRADE-IN-APPRAISALS.md).

Stock matching is in **27 Stock matching**, after folders 25–26. Development simulation and a Sales-accessible brand mapped to the selected site are required. See [stock workflow and API details](../STOCK-MATCHING.md).

Pipeline stages and history are in **26 Sales pipeline and progress**, following folder 25. Read the latest enquiry version before moving a stage. See [pipeline workflow and API details](../SALES-PIPELINE.md).

Sales enquiries are in **25 Sales enquiries**. Sign in, select the correct site and confirm the Sales customer first. The folder creates a local enquiry and initial follow-up, saves salesLeadId/salesLeadVersion, reads and qualifies it, and verifies SERVICE denial. See [Sales enquiry API details](../SALES-ENQUIRIES.md).

## Quick start with test defaults

Import `Good-Showroom.postman_collection.json` and
`Good-Showroom-PRIVATE.postman_environment.json`, then select
**Good Showroom Local — PRIVATE ready to import** as the active environment.
The private file uses backend `.env` connection settings and the initial setup key.
Keep it local; it is excluded from Git. It contains no Supabase service-role key
or MongoDB connection string.

Sample credentials are included in the collection and environments:

- ADMIN: `showroom.admin@example.com` / `Showroom-Admin-Test!2026`
- SALES: `showroom.sales@example.com` / `Showroom-Sales-Test!2026`
- SERVICE: `showroom.service@example.com` / `Showroom-Service-Test!2026`
- Optional additional ADMIN: `showroom.admin2@example.com` / `Showroom-Admin2-Test!2026`

These are disposable test credentials, not existing accounts. Start the backend
with `pnpm start:dev`. For a fresh installation, send folder **00** once, then run
**01**, **02**, **02B**, **03**, **04**, **05**, **06**, and **07** in order.
Leave optional folders disabled. Tokens and IDs fill automatically. Running these
requests creates accounts and sample CRM records.

For an existing installation, use its real ADMIN credentials and skip folder 00.
Use new test emails for staff, or `userCreationMode=invitation` with existing staff
credentials. Defaults never reset existing passwords. To use a pasted access token,
clear that role's default email/password so its login request skips.

Regenerate from the backend directory with `node test/build-postman.mjs --local`.
This resets exported values; it does not change accounts or the imported Postman
environment. Reimport after regeneration. Without `--local`, only shareable files
are generated.

## Shareable template

Import both JSON files into Postman:

- `Good-Showroom.postman_collection.json`
- `Good-Showroom-Local.postman_environment.json`

Select the imported environment before sending requests, or use the collection's Variables
tab. Scripts read available Environment, Collection, and Global variables and ignore empty
values when a populated fallback exists. Generated IDs/tokens are saved to the environment
when that variable exists there, otherwise to the collection. An empty higher-priority
variable is normalized for each request so it does not hide a populated fallback.

## Fill the environment

`supabaseUrl` is prefilled with your project URL, without a trailing slash.
Set `supabasePublicKey` to the project's publishable or legacy anon key.
Do not use a secret/service-role key. No MongoDB credentials are needed in Postman.

The files include three distinct sample account emails and passwords:
one initial administrator, one sales account, and one service account.
Replace `adminEmail`/`adminPassword`, `salesEmail`/`salesPassword`, and
`serviceEmail`/`servicePassword` locally when using existing accounts. Keep real
credentials out of exported/shared copies.
Alternatively, paste `adminToken`, `salesToken`, and `serviceToken` from signed-in sessions
and leave passwords blank. Identity requests capture the user IDs and emails automatically.
Tokens must be access tokens, not API keys or refresh tokens.

For a new installation, run folder 00 manually to create the initial Supabase account using
your setup key. It becomes ADMIN only after login and dealership setup. Passwords must be
12 to 128 characters. `userCreationMode=direct` is the default: folder 02B creates the two
staff identities and active memberships through the ADMIN-only backend route before login.
These trusted provisioning routes create confirmed staff identities without sending email.
The Supabase secret key remains on the backend; it is not a Postman variable.

For existing Supabase staff accounts, set `userCreationMode=invitation`; folder 02B skips
identity creation, signs in those accounts, and folder 03 creates/accepts application invitations.
Skip folder 00 if the initial account already exists. Existing passwords are never reset.

Start the backend with `pnpm start:dev`. `baseUrl` defaults to `http://localhost:4000/api`.
For an empty installation, fill `setupKey` with the backend's `INITIAL_SETUP_KEY`, and
review `organisationName`, `siteName`, and `timezone`. Existing installations skip setup.

## Run order

For a new initial account, run folder 00 once manually first. Then run folders 01 through 07
in order, including folder 02B, manually or through Collection Runner:

1. Login and verify the ADMIN identity. Tokens, refresh tokens, user IDs, and missing emails are saved.
2. Check setup state, bootstrap if necessary, then capture organisation/site IDs and ADMIN access.
3. Folder 02B creates SALES/SERVICE accounts in direct mode, then logs them in and verifies identities.
   Folder 03 reuses memberships in direct mode, or creates/accepts invitations in invitation mode.
4. Check ADMIN membership, audit, customer, and team-task access.
5. Create a SALES sample customer and follow-up; verify own-task access and blocked administration.
6. Repeat for SERVICE and verify SALES cannot complete the SERVICE follow-up.
7. Verify missing/invalid tokens and malformed identifiers are rejected.

Use test accounts with default permissions. Additional `tasks.view_team` permissions or
additional memberships can intentionally change the expected negative-test results.
`unauthorizedSiteId` defaults to a nonexistent UUID, which tests denied site access.
Replace it with an actual other-site UUID to check isolation against a real existing site.

The default role workflows create sample customers and completed tasks in the configured
database. Names include `Postman` and a timestamp. Repeating these workflows creates
additional samples; no deletion request exists in the current API.

Onboarding reuses matching memberships and pending invitations. Expired invitations can be
replaced. If a membership is suspended, restore it as ADMIN before running normal role checks.
If a pending invitation for the same email has a different site/role, resolve or revoke that
invitation first; a new invitation can otherwise return 409.

For multi-site administrators, the setup/context requests choose the first available ADMIN
site when there is no selected site. After folder 02, set the intended `siteId` before onboarding.
Do not rerun the initial setup-state request if you need to preserve a manually selected site.

## Optional flows

Folder 04B creates another ADMIN using the signed-in administrator's token. Fill
`additionalAdminEmail` and `additionalAdminPassword`, then set
`allowAdditionalAdminCreation=true` and run this folder manually. It creates a new
organisation-wide ADMIN, signs that account in, and verifies staff-management access.
Use a new email, then disable the flag again. ADMIN requests use `siteId: null`.
SALES and SERVICE creation examples remain in folder 02B with a selected `siteId`.
All three roles use the same ADMIN-only `POST /api/admin/users` endpoint.

Folder 08 suspends SALES, verifies denial with the same token, and restores access.
It skips unless `runAccessMutationTests=true`. Use a test account with only one SALES
membership. If the run stops after suspension, send the restore request before continuing.

Folder 09 sends real invitation emails. It skips unless `allowInvitationEmails=true`.
Run manually while the invitation is pending, before accepting it. In a full sequential run,
folder 03 already accepts invitations, so folder 09 must remain disabled.
The backend also requires its server-only Supabase key and invitation redirect configuration.

Folder 10 refreshes tokens. It skips unless `runSessionRefresh=true`. Enable and run it
manually when needed, or repeat the login requests. Refresh responses replace both tokens.

## Troubleshooting

- Connection refused: start the backend and verify `baseUrl`.
- Login failure: verify Supabase URL, public key, password, and email confirmation.
- 403 after valid login: verify an active MongoDB membership for the selected site.
- 409 invitation creation: a different pending invitation already exists for that email.
- 409 direct creation: that email already exists in Supabase; use invitation mode.
- 503 USER_PROVISIONING_INCOMPLETE: Supabase created the identity but MongoDB access needs
  verification. Check memberships; grant access by invitation if missing. Do not reset/delete accounts blindly.
- 400 accepting an invitation: it was already accepted, revoked, expired, or belongs to another email.
- Task ownership checks fail: the account may have team permissions or another role.

Post-response scripts verify expected HTTP codes and save IDs automatically. Optional
requests show as skipped unless enabled. Shareable files contain sample credentials,
not your `.env` values. The PRIVATE environment contains local connection settings.

Supabase password authentication reference: https://supabase.com/docs/guides/auth/passwords
Postman variable scope reference: https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-variables/

Site/brand foundation update (9 October 2026): collection now has 15 folders and
89 requests. Folder 11 verifies omitted-site rejection. Folder 12 covers site/brand
routes, pagination, and staff restrictions against a real second-site fixture.
Set runFoundationManagementTests=true to enable fixture creation, mapping updates,
and restricted invitation creation/revocation. It creates durable test site/brand
records and sends no email. Keep foundationBrandId/foundationSiteId for repeat runs;
if interrupted with a pending fixture invitation, revoke it before recreating it.
Leave the flag false for read-only/rejection checks. Both staff accounts must be
assigned only to the original site for the second-site rejection expectations.
The temporary MongoDB integration suite verifies brand restriction acceptance,
role isolation, and rollback; these are not claimed as live Postman executions.

Step 2 update: 17 folders, 113 requests. Customer creation now expects 202 and
Idempotency-Key, followed by command processing/status retrieval before tasks.
For a deterministic local simulation run, set INTEGRATION_MODE=simulated,
ALLOW_SIMULATED_INTEGRATION=true, and INTEGRATION_WORKER_ENABLED=false in the backend.
The collection reads integration/status; it does not enable backend modes for you.
Folder 13 mutations require runIntegrationTests=true. Folder 14 examples require
runScrapingRunnerExamples=true and real normalized observation variables; execute
only the individual request applicable to the current command state. They are not
an automatic browser scraper. Never fabricate source IDs or success results to make
a test pass. See ../INTEGRATION-RUNNER.md for scraping claim/heartbeat/result flow.

Customer 360 increment 1: collection now has 18 folders and 121 requests. Run folder
15 after folders 05/06 produce confirmed customer IDs and follow-ups. It includes
staff profile access, ADMIN linked-follow-up paging, missing/unknown access checks,
and an optional real second-site check using foundationSiteId. Existing variable
values in the private export are preserved when regenerating with --local. These
requests are examples; live requests were not executed by this implementation run.

Customer 360 activity update: 19 folders, 128 requests. Run folder 16 after customer
and follow-up workflows 05/06. It covers staff activity, ADMIN paging, unknown
customers, invalid pagination, and missing authentication. Only permitted task
history is returned; raw administrator audit metadata is excluded. No actual
Pentana scraping or frontend changes are part of this increment.

My Day update: 20 folders, 140 requests. Folder 17 covers personal/team queues,
overdue/today/call filters, call-task scheduling, invalid inputs, and authentication.
Run after folders 05/06 create confirmed customers. SALES team-denial expectations
assume its default permissions. My Day uses the configured SITE timezone. ADMIN
must use view=team for team work. Call scheduling does not log or dial actual calls.

My Day verification update: collection has 20 folders and 143 requests. Folder 17
now checks ownership, open status, counts, page limits, selected site-local date,
next-page offset, and invalid bucket. Live requests were not rerun by the agent.
Source-mode, team-permission changes, and orphaned-link exclusion are verified by
MongoDB integration tests. See IMPLEMENTATION-PLAN.md for the unfinished Step 3 work.

Notes/calls update (13 October 2026): collection now has 21 folders and 155 requests.
Folder 18 logs internal notes and calls, creates a promised callback, verifies
idempotent replay, reads shared journal/timeline, and covers invalid input/auth.
Run after folder 05 produces salesCustomerId. SERVICE shared-journal request requires
same-site access. Keep saved salesNoteKey/salesCallKey/journalFollowUpDueAt for
retries; clear them to create new samples. No actual dialling or Pentana write occurs.
Notes/calls require a bearer token and Idempotency-Key; shared entries are append-only.

Step 3 completion update: 24 folders, 184 requests. Folders 19–21 cover queued
contact edits/consent/shared change states, task editing/rescheduling/reassignment/
cancellation, and email drafts/explicit simulation sending/replay/delivery history.
Set runStep3Tests=true after the confirmed SALES customer workflow, then run these
folders in order. Backend must use INTEGRATION_MODE=simulated,
ALLOW_SIMULATED_INTEGRATION=true, INTEGRATION_WRITES_ENABLED=true and
MESSAGE_TRANSPORT=simulated. Restart after configuration changes. Both server modes
are verified before sample mutations/sends; the email workflow refuses live SMTP.
Turn the flag off afterward. SMTP credentials belong on the server, never Postman.
Live SMTP remains unconfigured/unverified; SMS needs its own provider. See
../CUSTOMER-360.md for recovery/reconciliation APIs and real SMTP setup.
Collection scripts parse and five variable-scope checks pass; live Postman requests
were not run. The PRIVATE environment preserves existing credentials/runtime IDs.

Frontend integration update: 24 folders, 186 requests. Folder 20 now includes the
assignment-authorized staff directory and default SALES rejection. These endpoints
support named assignee selection in the frontend. PRIVATE credentials/runtime IDs
were preserved; use valid existing accounts rather than assuming sample logins exist.
The active frontend now exercises Steps 1–3; see ../my-app/FRONTEND-INTEGRATION.md.
