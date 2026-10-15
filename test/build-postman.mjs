import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';

const folders = [];
const event = (listen, code) => ({ listen, script: { type: 'text/javascript', exec: code.split('\n') } });
const status = code => `pm.test('HTTP ${code}', () => pm.response.to.have.status(${code}));`;
const auth = role => ({ type: 'bearer', bearer: [{ key: 'token', value: `{{${role}Token}}`, type: 'string' }] });
const guard = names => `const missing = ${JSON.stringify(names)}.filter(key => !pm.environment.get(key));
if (missing.length) { throw new Error('Set these variables in the active environment or collection: ' + missing.join(', ')); }`;
function request(name, method, path, role, body, code = 200, extra = '', pre = '', description = '') {
  return {
    name,
    request: {
      method, auth: role ? auth(role) : { type: 'noauth' },
      header: body === undefined ? [] : [{ key: 'Content-Type', value: 'application/json' }],
      url: path.startsWith('{{supabaseUrl}}') ? path : `{{baseUrl}}/${path}`,
      ...(body === undefined ? {} : { body: { mode: 'raw', raw: JSON.stringify(body, null, 2), options: { raw: { language: 'json' } } } }),
      description,
    },
    event: [...(pre ? [event('prerequest', pre)] : []), event('test', `${status(code)}\nif (pm.response.code === ${code}) {\n${extra}\n}`)],
  };
}
const folder = (name, item, description) => folders.push({ name, item, description });
const save = (variable, expression) => `pm.environment.set('${variable}', ${expression});`;
const contextScript = role => `const data = pm.response.json();
${save(`${role}UserId`, 'data.user.id')}
const site = data.sites.find(site => site.id === pm.environment.get('siteId')) || data.sites[0];
if (site) {
  ${role === 'admin' ? "pm.environment.set('siteId', site.id); pm.environment.set('organisationId', site.organisation_id);" : ''}
  pm.test('${role.toUpperCase()} has the expected role at the selected site', () => pm.expect(site.roles).to.include('${role.toUpperCase()}'));
} else { pm.test('An active site membership is required', () => pm.expect(data.sites.length).to.be.above(0)); }
const membership = data.memberships.find(item => item.role === '${role.toUpperCase()}' && item.organisation_id === pm.environment.get('organisationId') && (item.site_id === null || item.site_id === pm.environment.get('siteId')));
if (membership) { ${save(`${role}MembershipId`, 'membership.id')} }`;

folder('01 Login to Supabase', ['admin', 'sales', 'service'].map(role => {
  const item = request(`${role.toUpperCase()} login and save token`, 'POST', '{{supabaseUrl}}/auth/v1/token?grant_type=password', null,
    { email: `{{${role}Email}}`, password: `{{${role}Password}}` }, 200,
    `const data = pm.response.json();
pm.test('Access token returned', () => pm.expect(data.access_token).to.be.a('string'));
${save(`${role}Token`, 'data.access_token')}
${save(`${role}RefreshToken`, 'data.refresh_token')}
${save(`${role}UserId`, 'data.user.id')}`,
    `${guard(['supabaseUrl', 'supabasePublicKey'])}
const email = pm.environment.get('${role}Email');
const password = pm.environment.get('${role}Password');
if ((!email || !password) && pm.environment.get('${role}Token')) { pm.execution.skipRequest(); }
else {
  if (!email || !password) { throw new Error('Fill ${role}Email and ${role}Password, or paste ${role}Token.'); }
  pm.request.body.update(JSON.stringify({ email, password }));
}`,
    'Uses a confirmed existing Supabase email/password account. Saves access and refresh tokens to the selected environment. You may instead paste a real access token and leave email/password blank. No users are created by this request.');
  item.request.header.push({ key: 'apikey', value: '{{supabasePublicKey}}' });
  return item;
}), 'Prepare three distinct confirmed Supabase users. Set credentials locally or paste their access tokens. Never use the service-role key as supabasePublicKey.');
for (const role of ['admin', 'sales', 'service']) {
  folders[0].item.push(request(`Verify ${role.toUpperCase()} identity before role assignment`, 'GET', 'auth/me', role, undefined, 200,
    `const user = pm.response.json().user;
${save(`${role}UserId`, 'user.id')}
if (!pm.environment.get('${role}Email') && user.email) { ${save(`${role}Email`, 'user.email')} }
${role === 'service' ? "pm.test('Three distinct test accounts are configured', () => pm.expect(new Set(['admin', 'sales', 'service'].map(role => pm.environment.get(role + 'UserId'))).size).to.eql(3));" : ''}`,
    guard([`${role}Token`]), 'Captures the verified identity even when an access token was pasted manually. A membership is not required for this request.'));
}

folder('02 Dealership setup and ADMIN context', [
  request('Check current ADMIN account and setup state', 'GET', 'auth/me', 'admin', undefined, 200,
    `const data = pm.response.json(); ${save('needsInitialSetup', "String(data.needsInitialSetup)")}
${save('adminUserId', 'data.user.id')}
const site = data.sites.find(item => item.roles.includes('ADMIN'));
if (site) { pm.environment.set('siteId', site.id); pm.environment.set('organisationId', site.organisation_id); }
const membership = data.memberships.find(item => item.role === 'ADMIN' && item.organisation_id === pm.environment.get('organisationId'));
if (membership) { ${save('adminMembershipId', 'membership.id')} }`, guard(['adminToken'])),
  request('Initial setup — skipped when already configured', 'POST', 'setup', 'admin', {
    organisationName: '{{organisationName}}', siteName: '{{siteName}}', timezone: '{{timezone}}', setupKey: '{{setupKey}}',
  }, 201,
  `const data = pm.response.json(); ${save('organisationId', 'data.setup.organisation_id')} ${save('siteId', 'data.setup.site_id')} ${save('needsInitialSetup', "'false'")}`,
  `if (pm.environment.get('needsInitialSetup') === 'false') { pm.execution.skipRequest(); }
else {
  ${guard(['adminToken', 'setupKey'])}
  if (pm.environment.get('needsInitialSetup') !== 'true') throw new Error('Run the setup-state request first.');
  pm.request.body.update(JSON.stringify({ organisationName: pm.environment.get('organisationName'), siteName: pm.environment.get('siteName'), timezone: pm.environment.get('timezone'), setupKey: pm.environment.get('setupKey') }));
}`, 'Creates the first organisation, site, and ADMIN membership. Run only for an empty installation.'),
  request('ADMIN context — capture IDs and permissions', 'GET', 'auth/me', 'admin', undefined, 200, contextScript('admin')),
  request('List memberships — discover existing staff', 'GET', 'admin/memberships?organisationId={{organisationId}}', 'admin', undefined, 200,
    `const memberships = pm.response.json().memberships;
for (const role of ['sales', 'service']) {
  pm.environment.unset(role + 'MembershipId');
  const item = memberships.find(item => item.user_id === pm.environment.get(role + 'UserId') && item.role === role.toUpperCase() && (item.site_id === null || item.site_id === pm.environment.get('siteId')));
  if (item) { pm.environment.set(role + 'MembershipId', item.id); }
}`, guard(['organisationId', 'siteId'])),
], 'Run in order. Setup automatically skips on an existing installation. If multiple sites exist, select the intended siteId before proceeding.');

const onboarding = [];
for (const role of ['sales', 'service']) {
  onboarding.push(
    request(`Find pending ${role.toUpperCase()} invitation`, 'GET', 'admin/invitations?organisationId={{organisationId}}', 'admin', undefined, 200,
      `pm.environment.unset('${role}InvitationId');
const email = (pm.environment.get('${role}Email') || '').toLowerCase();
const item = pm.response.json().invitations.find(item => item.email === email && item.status === 'pending' && Date.parse(item.expires_at) > Date.now() && item.roles.includes('${role.toUpperCase()}') && item.site_id === pm.environment.get('siteId'));
if (item) { ${save(`${role}InvitationId`, 'item.id')} }`),
    request(`Create ${role.toUpperCase()} invitation — skip existing access/invite`, 'POST', 'admin/invitations', 'admin', {
      organisationId: '{{organisationId}}', siteId: '{{siteId}}', email: `{{${role}Email}}`, roles: [role.toUpperCase()],
    }, 201, save(`${role}InvitationId`, 'pm.response.json().invitation.id'),
    `if (pm.environment.get('${role}MembershipId') || pm.environment.get('${role}InvitationId')) { pm.execution.skipRequest(); }
else { ${guard(['organisationId', 'siteId', `${role}Email`])} }`),
    request(`List invitations as ${role.toUpperCase()}`, 'GET', 'auth/invitations', role, undefined, 200,
      `pm.test('Invitations returned', () => pm.expect(pm.response.json().invitations).to.be.an('array'));`),
    request(`Accept ${role.toUpperCase()} invitation — skip existing membership`, 'POST', `auth/invitations/{{${role}InvitationId}}/accept`, role, {}, 201,
      `const item = pm.response.json().memberships.find(item => item.role === '${role.toUpperCase()}' && (item.site_id === null || item.site_id === pm.environment.get('siteId')));
pm.test('Expected membership created', () => pm.expect(item).to.exist);
if (item) { ${save(`${role}MembershipId`, 'item.id')} }`,
      `if (pm.environment.get('${role}MembershipId')) { pm.execution.skipRequest(); }
else { ${guard([`${role}InvitationId`, `${role}Token`])} }`),
    request(`${role.toUpperCase()} context and permissions`, 'GET', 'auth/me', role, undefined, 200, contextScript(role)),
  );
}
folder('03 Staff memberships and invitation acceptance', onboarding,
  'Creates application invitations for your two existing Supabase accounts and accepts them with their respective tokens. No email is sent. Existing memberships are reused. Suspended memberships must be reactivated by ADMIN first.');

folder('04 ADMIN checks', [
  request('List dealership memberships', 'GET', 'admin/memberships?organisationId={{organisationId}}', 'admin', undefined, 200),
  request('List dealership invitations', 'GET', 'admin/invitations?organisationId={{organisationId}}', 'admin', undefined, 200),
  request('Read audit history', 'GET', 'admin/audit?organisationId={{organisationId}}', 'admin', undefined, 200),
  request('Read shared customers', 'GET', 'customers?siteId={{siteId}}', 'admin', undefined, 200),
  request('Read team tasks', 'GET', 'tasks?siteId={{siteId}}&through=2099-01-01T00:00:00.000Z', 'admin', undefined, 200),
], 'ADMIN access is limited to the configured dealership.');

for (const role of ['sales', 'service']) {
  const pre = `pm.variables.set('sampleSuffix', Date.now().toString()); pm.variables.set('dueAt', new Date(Date.now() - 60000).toISOString());`;
  const items = [
    request('Check integration mode', 'GET', 'integration/status', role, undefined, 200, save('integrationMode', 'pm.response.json().mode')),
    request('Current role and site access', 'GET', 'auth/me', role, undefined, 200, contextScript(role)),
    request('Create sample customer', 'POST', 'customers', role, { siteId: '{{siteId}}', firstName: 'Postman', lastName: `${role.toUpperCase()} {{sampleSuffix}}`, email: `postman-${role}-{{sampleSuffix}}@example.test` }, 202,
      save(`${role}CommandId`, 'pm.response.json().command.id'), pre, 'Queues a customer write; it becomes a customer only after a confirmed source result.'),
    request('Process customer in development simulator', 'POST', `admin/integration/commands/{{${role}CommandId}}/process`, 'admin', {}, 201, '', `if (pm.environment.get('integrationMode') !== 'simulated') { pm.execution.skipRequest(); }`),
    request('Read customer command and capture confirmed customer ID', 'GET', `integration/commands/{{${role}CommandId}}`, role, undefined, 200,
      `const data = pm.response.json();
if (data.command.status !== 'succeeded' || !data.customer) throw new Error('Customer write is still ' + data.command.status + '; finish it with the scraping runner or inspect failures, then rerun this request before tasks.');
${save(`${role}CustomerId`, 'data.customer.id')}`),
    request('Search sample customers', 'GET', 'customers?siteId={{siteId}}&search=Postman', role, undefined, 200),
    request('Create own follow-up', 'POST', 'tasks', role, { siteId: '{{siteId}}', customerId: `{{${role}CustomerId}}`, title: `Postman ${role.toUpperCase()} follow-up`, details: 'Created by the Postman role test collection.', dueAt: '{{dueAt}}', priority: 'normal' }, 201,
      save(`${role}TaskId`, 'pm.response.json().task.id'), pre),
    request('Read own tasks', 'GET', 'tasks?siteId={{siteId}}&through=2099-01-01T00:00:00.000Z', role, undefined, 200,
      `const tasks = pm.response.json().tasks;
pm.test('Default staff task view contains only own assignments', () => pm.expect(tasks.every(task => task.assigned_to === pm.environment.get('${role}UserId'))).to.eql(true));
pm.test('Created follow-up is present', () => pm.expect(tasks.map(task => task.id)).to.include(pm.environment.get('${role}TaskId')));`, '', 'Assumes the staff membership has default permissions, without tasks.view_team.'),
  ];
  const customerWrite = items.find(item => item.name === 'Create sample customer');
  customerWrite.request.header.push({ key: 'Idempotency-Key', value: `postman-${role}-{{sampleSuffix}}` });
  if (role === 'service') items.push(request('SALES cannot complete SERVICE follow-up', 'PATCH', 'tasks/{{serviceTaskId}}/complete?siteId={{siteId}}', 'sales', {}, 400));
  items.push(
    request('Complete own follow-up', 'PATCH', `tasks/{{${role}TaskId}}/complete?siteId={{siteId}}`, role, {}, 200),
    request('Reject completing it twice', 'PATCH', `tasks/{{${role}TaskId}}/complete?siteId={{siteId}}`, role, {}, 400),
    request('Deny staff administration', 'GET', 'admin/memberships?organisationId={{organisationId}}', role, undefined, 403),
    request('Deny audit access', 'GET', 'admin/audit?organisationId={{organisationId}}', role, undefined, 403),
    request('Deny access to an unrelated site', 'GET', 'customers?siteId={{unauthorizedSiteId}}', role, undefined, 403),
  );
  folder(role === 'sales' ? '05 SALES workflow' : '06 SERVICE workflow', items,
    'Run on test accounts with default permissions. This folder creates a sample customer and follow-up, then completes the follow-up. Repeat runs create additional samples; the API has no deletion endpoint.');
}

const invalid = request('Invalid token is rejected', 'GET', 'auth/me', null, undefined, 401);
invalid.request.auth = { type: 'bearer', bearer: [{ key: 'token', value: 'deliberately-invalid-test-token', type: 'string' }] };
folder('07 Authentication boundaries', [
  request('Missing token is rejected', 'GET', 'auth/me', null, undefined, 401), invalid,
  request('Malformed site ID is rejected', 'GET', 'customers?siteId=not-a-uuid', 'sales', undefined, 400),
]);

const optionalGuard = `if (pm.environment.get('runAccessMutationTests') !== 'true') { pm.execution.skipRequest(); }
else { ${guard(['salesMembershipId', 'organisationId', 'siteId', 'adminToken', 'salesToken'])} }`;
folder('08 Optional SALES suspension and restore', [
  request('Suspend SALES membership', 'PATCH', 'admin/memberships/{{salesMembershipId}}', 'admin', { organisationId: '{{organisationId}}', status: 'suspended' }, 200, '', optionalGuard),
  request('Same SALES token now has no customer access', 'GET', 'customers?siteId={{siteId}}', 'sales', undefined, 403, '', optionalGuard),
  request('Restore SALES membership', 'PATCH', 'admin/memberships/{{salesMembershipId}}', 'admin', { organisationId: '{{organisationId}}', status: 'active' }, 200, '', optionalGuard),
  request('Same SALES token works after restoration', 'GET', 'customers?siteId={{siteId}}', 'sales', undefined, 200, '', optionalGuard),
], 'Skipped by default. Set runAccessMutationTests=true only for a dedicated test account with a single SALES membership. Run all four requests in order. If interrupted after suspension, run the restore request.');

folder('09 Optional invitation emails', ['sales', 'service'].map(role => request(`Send ${role.toUpperCase()} invitation email`, 'POST', `admin/invitations/{{${role}InvitationId}}/send`, 'admin', { organisationId: '{{organisationId}}' }, 201,
  `pm.test('Email submitted', () => pm.expect(pm.response.json().sent).to.eql(true));`,
  `if (pm.environment.get('allowInvitationEmails') !== 'true') { pm.execution.skipRequest(); }
else { ${guard([`${role}InvitationId`, 'organisationId', 'adminToken'])} }`,
  'Sends a real email. Requires a pending unexpired application invitation. Already accepted invitations return 400. This is a separate manual flow: create invitation, send, sign in, then accept.')),
  'Skipped by default. To test email delivery, set allowInvitationEmails=true and run this folder manually BEFORE accepting the invitation. Email is not part of the default onboarding flow.');

folder('10 Optional session refresh', ['admin', 'sales', 'service'].map(role => {
  const item = request(`Refresh ${role.toUpperCase()} session`, 'POST', '{{supabaseUrl}}/auth/v1/token?grant_type=refresh_token', null,
    { refresh_token: `{{${role}RefreshToken}}` }, 200,
    `const data = pm.response.json(); ${save(`${role}Token`, 'data.access_token')} ${save(`${role}RefreshToken`, 'data.refresh_token')}`,
    `if (pm.environment.get('runSessionRefresh') !== 'true') { pm.execution.skipRequest(); }
else { ${guard(['supabaseUrl', 'supabasePublicKey', `${role}RefreshToken`])} }`);
  item.request.header.push({ key: 'apikey', value: '{{supabasePublicKey}}' });
  return item;
}), 'Skipped by default. Set runSessionRefresh=true and run manually when access tokens expire.');

// Direct creation lets a new installation start without pre-existing Supabase accounts.
const loginFolder = folders.find(group => group.name === '01 Login to Supabase');
const staffLoginItems = loginFolder.item.filter(item => !item.name.includes('ADMIN'));
loginFolder.item = loginFolder.item.filter(item => item.name.includes('ADMIN'));
loginFolder.name = '01 ADMIN login to Supabase';
loginFolder.description = 'Sign in with the account created by folder 00, or an existing confirmed administrator account.';
folders.unshift({ name: '00 Create initial account — run once manually', description: 'For a new installation: fill setupKey, adminEmail, and adminPassword, then create the first identity. It receives ADMIN access only after login and dealership setup. Existing installations should skip this folder. No email is sent.', item: [
  request('Create initial administrator account', 'POST', 'auth/initial-user', null,
    { email: '{{adminEmail}}', password: '{{adminPassword}}', fullName: 'Initial administrator', setupKey: '{{setupKey}}' }, 201,
    `${save('adminUserId', 'pm.response.json().user.id')} pm.test('Next step is sign-in and setup', () => pm.expect(pm.response.json().nextStep).to.be.a('string'));`,
    `${guard(['adminEmail', 'adminPassword', 'setupKey'])}
pm.request.body.update(JSON.stringify({ email: pm.environment.get('adminEmail'), password: pm.environment.get('adminPassword'), fullName: 'Initial administrator', setupKey: pm.environment.get('setupKey') }));`),
] });
const directItems = ['sales', 'service'].map(role => request(`Create ${role.toUpperCase()} account and membership`, 'POST', 'admin/users', 'admin',
  { organisationId: '{{organisationId}}', siteId: '{{siteId}}', email: `{{${role}Email}}`, password: `{{${role}Password}}`, fullName: `${role.toUpperCase()} test user`, roles: [role.toUpperCase()] }, 201,
  `${save(`${role}UserId`, 'pm.response.json().user.id')}
const member = pm.response.json().memberships.find(item => item.role === '${role.toUpperCase()}');
if (member) { ${save(`${role}MembershipId`, 'member.id')} }`,
  `if (pm.environment.get('userCreationMode') !== 'direct' || pm.environment.get('${role}MembershipId')) { pm.execution.skipRequest(); }
else {
  ${guard(['adminToken', 'organisationId', 'siteId', `${role}Email`, `${role}Password`])}
  pm.request.body.update(JSON.stringify({ organisationId: pm.environment.get('organisationId'), siteId: pm.environment.get('siteId'), email: pm.environment.get('${role}Email'), password: pm.environment.get('${role}Password'), fullName: '${role.toUpperCase()} test user', roles: ['${role.toUpperCase()}'] }));
}`, 'Creates a new Supabase account and active MongoDB membership. Existing emails return 409 without resetting passwords; use invitation mode for those accounts.'));
const setupIndex = folders.findIndex(group => group.name === '02 Dealership setup and ADMIN context');
folders.splice(setupIndex + 1, 0, { name: '02B Create staff accounts and login', item: [...directItems, ...staffLoginItems],
  description: 'Default userCreationMode=direct creates SALES and SERVICE accounts before signing them in. Use userCreationMode=invitation for existing accounts; direct creation skips and folder 03 grants access through invitations.' });

const environment = {
  id: randomUUID(), name: 'Good Showroom Local — test defaults', _postman_variable_scope: 'environment',
  values: Object.entries({
    baseUrl: 'http://localhost:4000/api', supabaseUrl: 'https://ocxjzmybstkveytjdgcb.supabase.co', supabasePublicKey: '',
    organisationName: 'Good Showroom Test', siteName: 'Pilot Site', timezone: 'Australia/Sydney', setupKey: '',
    organisationId: '', siteId: '', unauthorizedSiteId: '00000000-0000-0000-0000-000000000000', needsInitialSetup: '',
    ...Object.fromEntries(['admin', 'sales', 'service'].flatMap(role => ['Email', 'Password', 'Token', 'RefreshToken', 'UserId', 'MembershipId', 'InvitationId', 'CustomerId', 'TaskId', 'CommandId'].map(suffix => [role + suffix, '']))),
    adminEmail: 'showroom.admin@example.com', adminPassword: 'Showroom-Admin-Test!2026',
    salesEmail: 'showroom.sales@example.com', salesPassword: 'Showroom-Sales-Test!2026',
    serviceEmail: 'showroom.service@example.com', servicePassword: 'Showroom-Service-Test!2026',
    runAccessMutationTests: 'false', allowInvitationEmails: 'false', runSessionRefresh: 'false',
    runScrapingRunnerExamples: 'false', scrapingOutcome: '', scrapingCustomerJson: '', scrapingErrorCode: '', scrapingErrorMessage: '', integrationRetryNote: '', confirmedNotApplied: 'false', simulatorBehavior: 'accept',
    salesNoteKey: '', salesCallKey: '', journalFollowUpDueAt: '', salesNoteId: '', salesCallId: '', promisedCallTaskId: '',
    myDayDate: '', myDayCallTaskId: '',
    runStep3Tests: 'false', step3SimulationVerified: 'false', messagingSimulationVerified: 'false', step3EditKey: '', step3PrivacyKey: '', step3CommandId: '', step3TaskId: '', step3TaskVersion: '', step3MessageId: '', step3MessageVersion: '', step3DraftKey: '', step3SendKey: '', step3ProviderId: '',
    integrationMode: '', runIntegrationTests: 'false', integrationCommandId: '', integrationLeaseToken: '', integrationIdempotencyKey: '', scrapedCustomerExternalId: '',
    userCreationMode: 'direct', runFoundationManagementTests: 'false', foundationBrandId: '', foundationSiteId: '', foundationInvitationId: '',
    allowAdditionalAdminCreation: 'false', additionalAdminEmail: 'showroom.admin2@example.com', additionalAdminPassword: 'Showroom-Admin2-Test!2026',
    additionalAdminFullName: 'Additional administrator', additionalAdminToken: '', additionalAdminUserId: '',
  }).map(([key, value]) => ({ key, value, enabled: true, type: /Password|Token|Key/.test(key) ? 'secret' : 'default' })),
};
const additionalAdminGuard = `if (pm.environment.get('allowAdditionalAdminCreation') !== 'true') { pm.execution.skipRequest(); }
else { ${guard(['adminToken', 'organisationId', 'additionalAdminEmail', 'additionalAdminPassword'])} }`;
const additionalAdminLogin = request('Login as the additional ADMIN', 'POST', '{{supabaseUrl}}/auth/v1/token?grant_type=password', null,
  { email: '{{additionalAdminEmail}}', password: '{{additionalAdminPassword}}' }, 200,
  `${save('additionalAdminToken', 'pm.response.json().access_token')} ${save('additionalAdminUserId', 'pm.response.json().user.id')}`,
  `${additionalAdminGuard}
if (pm.environment.get('allowAdditionalAdminCreation') === 'true') {
  ${guard(['supabaseUrl', 'supabasePublicKey'])}
  pm.request.body.update(JSON.stringify({ email: pm.environment.get('additionalAdminEmail'), password: pm.environment.get('additionalAdminPassword') }));
}`);
additionalAdminLogin.request.header.push({ key: 'apikey', value: '{{supabasePublicKey}}' });
folders.splice(folders.findIndex(group => group.name === '04 ADMIN checks') + 1, 0, {
  name: '04B Create another ADMIN — optional manual flow',
  description: 'Set allowAdditionalAdminCreation=true and fill additionalAdminEmail/additionalAdminPassword. Creates a real organisation-wide administrator. Run manually with a new email, then disable the flag again. Repeating creation returns 409. This uses the same POST /admin/users endpoint as SALES and SERVICE.',
  item: [
    request('Create an additional organisation-wide ADMIN', 'POST', 'admin/users', 'admin',
      { organisationId: '{{organisationId}}', siteId: null, email: '{{additionalAdminEmail}}', password: '{{additionalAdminPassword}}', fullName: '{{additionalAdminFullName}}', roles: ['ADMIN'] }, 201,
      `${save('additionalAdminUserId', 'pm.response.json().user.id')}
pm.test('ADMIN is organisation-wide', () => pm.expect(pm.response.json().memberships[0].site_id).to.eql(null));`,
      `${additionalAdminGuard}
if (pm.environment.get('allowAdditionalAdminCreation') === 'true') {
  pm.request.body.update(JSON.stringify({ organisationId: pm.environment.get('organisationId'), siteId: null, email: pm.environment.get('additionalAdminEmail'), password: pm.environment.get('additionalAdminPassword'), fullName: pm.environment.get('additionalAdminFullName'), roles: ['ADMIN'] }));
}`),
    additionalAdminLogin,
    request('Verify the additional ADMIN can manage this dealership', 'GET', 'admin/memberships?organisationId={{organisationId}}', 'additionalAdmin', undefined, 200, '',
      `if (pm.environment.get('allowAdditionalAdminCreation') !== 'true') { pm.execution.skipRequest(); }
else { ${guard(['additionalAdminToken', 'organisationId'])} }`),
  ],
});
folders.push({ name: '11 Site assignment validation', item: ['SALES', 'SERVICE'].flatMap(role => [
    request('Reject ' + role + ' account without site', 'POST', 'admin/users', 'admin', { organisationId: '{{organisationId}}', email: 'scope-check@example.test', password: 'Scope-Test!2026', roles: [role] }, 400),
    request('Reject ' + role + ' invitation without site', 'POST', 'admin/invitations', 'admin', { organisationId: '{{organisationId}}', email: 'scope-check@example.test', roles: [role] }, 400),
  ]) });
const foundationGuard = `if (pm.environment.get('runFoundationManagementTests') !== 'true') { pm.execution.skipRequest(); }
else { ${guard(['adminToken', 'organisationId'])} }`;
const foundationRequirements = names => `if (pm.environment.get('runFoundationManagementTests') === 'true') { ${guard(names)} }`;
folder('12 Sites, brands, and pagination', [
  request('List ADMIN sites with pagination', 'GET', 'admin/sites?organisationId={{organisationId}}&limit=10&offset=0', 'admin', undefined, 200,
    "pm.test('Page metadata provided', () => pm.expect(pm.response.json().pagination.limit).to.eql(10));"),
  request('List ADMIN brands with pagination', 'GET', 'admin/brands?organisationId={{organisationId}}&limit=10', 'admin', undefined, 200),
  request('List accessible brands at assigned site', 'GET', 'sites/{{siteId}}/brands', 'sales', undefined, 200),
  request('Reject invalid customer page size', 'GET', 'customers?siteId={{siteId}}&limit=101', 'sales', undefined, 400),
  request('Reject invalid task offset', 'GET', 'tasks?siteId={{siteId}}&offset=-1', 'service', undefined, 400),
  request('Create fixture brand', 'POST', 'admin/brands', 'admin', { organisationId: '{{organisationId}}', name: 'Postman Fixture Brand' }, 201,
    save('foundationBrandId', 'pm.response.json().brand.id'), foundationGuard + `
if (pm.environment.get('foundationBrandId')) { pm.execution.skipRequest(); }
else if (pm.environment.get('runFoundationManagementTests') === 'true') { pm.request.body.update(JSON.stringify({ organisationId: pm.environment.get('organisationId'), name: 'Postman Fixture Brand ' + Date.now() })); }`),
  request('Create real second-site fixture mapped to the brand', 'POST', 'admin/sites', 'admin', { organisationId: '{{organisationId}}', name: 'Postman Second Site', brandIds: ['{{foundationBrandId}}'], timezone: 'Australia/Perth' }, 201,
    save('foundationSiteId', 'pm.response.json().site.id'), foundationGuard + `
if (pm.environment.get('foundationSiteId')) { pm.execution.skipRequest(); }
else if (pm.environment.get('runFoundationManagementTests') === 'true') {
  ${guard(['foundationBrandId'])}
  pm.request.body.update(JSON.stringify({ organisationId: pm.environment.get('organisationId'), name: 'Postman Second Site ' + Date.now(), brandIds: [pm.environment.get('foundationBrandId')], timezone: 'Australia/Perth' }));
}`),
  request('Rename fixture brand', 'PATCH', 'admin/brands/{{foundationBrandId}}', 'admin', { organisationId: '{{organisationId}}', name: 'Postman Fixture Brand Updated {{foundationBrandId}}' }, 200, '', foundationGuard + '\n' + foundationRequirements(['foundationBrandId'])),
  request('Update fixture site timezone', 'PATCH', 'admin/sites/{{foundationSiteId}}', 'admin', { organisationId: '{{organisationId}}', timezone: 'Australia/Sydney' }, 200, '', foundationGuard + '\n' + foundationRequirements(['foundationSiteId'])),
  request('ADMIN reads mapped brand at second site', 'GET', 'sites/{{foundationSiteId}}/brands/{{foundationBrandId}}', 'admin', undefined, 200, '', foundationGuard + '\n' + foundationRequirements(['foundationSiteId', 'foundationBrandId'])),
  ...['sales', 'service'].flatMap(role => [
    request(role.toUpperCase() + ' cannot manage sites', 'POST', 'admin/sites', role, { organisationId: '{{organisationId}}', name: 'Forbidden Site' }, 403),
    request(role.toUpperCase() + ' cannot manage brands', 'POST', 'admin/brands', role, { organisationId: '{{organisationId}}', name: 'Forbidden Brand' }, 403),
    request(role.toUpperCase() + ' cannot read customers at real second site', 'GET', 'customers?siteId={{foundationSiteId}}', role, undefined, 403, '', foundationGuard + '\n' + foundationRequirements(['foundationSiteId', role + 'Token'])),
    request(role.toUpperCase() + ' cannot read brand at real second site', 'GET', 'sites/{{foundationSiteId}}/brands/{{foundationBrandId}}', role, undefined, 403, '', foundationGuard + '\n' + foundationRequirements(['foundationSiteId', 'foundationBrandId', role + 'Token'])),
  ]),
  request('Reject unknown brand mapping', 'PATCH', 'admin/sites/{{foundationSiteId}}', 'admin', { organisationId: '{{organisationId}}', brandIds: ['00000000-0000-0000-0000-000000000000'] }, 400, '', foundationGuard + '\n' + foundationRequirements(['foundationSiteId'])),
  request('Create brand-restricted fixture invitation', 'POST', 'admin/invitations', 'admin', { organisationId: '{{organisationId}}', siteId: '{{foundationSiteId}}', brandIds: ['{{foundationBrandId}}'], email: 'foundation-fixture@example.test', roles: ['SALES'] }, 201,
    save('foundationInvitationId', 'pm.response.json().invitation.id'), foundationGuard + '\n' + foundationRequirements(['foundationSiteId', 'foundationBrandId'])),
  request('Revoke fixture invitation', 'POST', 'admin/invitations/{{foundationInvitationId}}/revoke', 'admin', { organisationId: '{{organisationId}}' }, 201, '', foundationGuard + '\n' + foundationRequirements(['foundationInvitationId'])),
], 'Read-only and rejection checks run normally. Set runFoundationManagementTests=true to create an isolated real brand/site fixture and a restricted invitation; no email is sent. Keep the saved fixture IDs for repeat runs. Requires SALES/SERVICE accounts assigned only to the original site.');
const integrationGuard = `if (pm.environment.get('runIntegrationTests') !== 'true') { pm.execution.skipRequest(); }
else { ${guard(['adminToken', 'organisationId', 'siteId', 'salesToken'])} }`;
folder('13 Integration commands and scraping runner', [
  request('Read integration mode and capabilities', 'GET', 'integration/status', 'admin', undefined, 200, save('integrationMode', 'pm.response.json().mode')),
  request('List integration commands', 'GET', 'admin/integration/commands?organisationId={{organisationId}}&limit=10', 'admin', undefined, 200),
  request('List failures needing review', 'GET', 'admin/integration/commands?organisationId={{organisationId}}&status=needs_review', 'admin', undefined, 200),
  request('Queue idempotent customer command', 'POST', 'customers', 'sales', { siteId: '{{siteId}}', firstName: 'Integration', lastName: 'Fixture', email: 'integration-fixture@example.test' }, 202,
    save('integrationCommandId', 'pm.response.json().command.id'), integrationGuard + `
if (pm.environment.get('runIntegrationTests') === 'true' && !pm.environment.get('integrationIdempotencyKey')) { pm.environment.set('integrationIdempotencyKey', 'postman-integration-' + Date.now()); }`),
  request('Replay identical command without duplicate customer', 'POST', 'customers', 'sales', { siteId: '{{siteId}}', firstName: 'Integration', lastName: 'Fixture', email: 'integration-fixture@example.test' }, 202,
    "pm.test('Same command returned', () => pm.expect(pm.response.json().command.id).to.eql(pm.environment.get('integrationCommandId')));", integrationGuard),
  request('Reject changed payload using the same key', 'POST', 'customers', 'sales', { siteId: '{{siteId}}', firstName: 'Different', lastName: 'Fixture', email: 'integration-fixture@example.test' }, 409, '', integrationGuard),
  request('Process command using simulator', 'POST', 'admin/integration/commands/{{integrationCommandId}}/process', 'admin', {}, 201, '', integrationGuard + `
if (pm.environment.get('integrationMode') !== 'simulated') { pm.execution.skipRequest(); }`),
  request('Read command outcome', 'GET', 'integration/commands/{{integrationCommandId}}', 'sales', undefined, 200, '', integrationGuard),
  request('Read request/response attempt audit', 'GET', 'admin/integration/commands/{{integrationCommandId}}/attempts', 'admin', undefined, 200, '', integrationGuard),
  request('Synchronize development source fixtures', 'POST', 'admin/integration/simulator/sync', 'admin', { siteId: '{{siteId}}' }, 201, '', integrationGuard + `
if (pm.environment.get('integrationMode') !== 'simulated') { pm.execution.skipRequest(); }`),
  request('Recover expired runner leases', 'POST', 'admin/integration/recover', 'admin', { organisationId: '{{organisationId}}' }, 201, '', integrationGuard),
], 'Mutations are optional; set runIntegrationTests=true after configuring integration mode. The idempotency key is saved for repeats; clear it to request another fixture. Browser scraping claims, heartbeats, and results are a manual runner workflow documented in INTEGRATION-RUNNER.md, not fabricated successful write acknowledgements.');
const integrationFolder = folders.find(group => group.name.startsWith('13 '));
for (const item of integrationFolder.item.filter(item => item.request.method === 'POST' && item.request.url.endsWith('/customers'))) item.request.header.push({ key: 'Idempotency-Key', value: '{{integrationIdempotencyKey}}' });
const runnerGuard = `if (pm.environment.get('runScrapingRunnerExamples') !== 'true') { pm.execution.skipRequest(); }
else { ${guard(['adminToken', 'integrationCommandId'])} }`;
folder('14 Manual scraping runner and recovery examples', [
  request('Claim a scraping write command', 'POST', 'admin/integration/commands/{{integrationCommandId}}/claim', 'admin', {}, 200,
    save('integrationLeaseToken', 'pm.response.json().leaseToken'), runnerGuard),
  request('Renew an active scraping lease', 'POST', 'admin/integration/commands/{{integrationCommandId}}/heartbeat', 'admin', { leaseToken: '{{integrationLeaseToken}}' }, 200, '', runnerGuard),
  request('Report verified browser write outcome', 'POST', 'admin/integration/commands/{{integrationCommandId}}/result', 'admin', {}, 200, '', runnerGuard + `
if (pm.environment.get('runScrapingRunnerExamples') === 'true') {
  ${guard(['integrationLeaseToken', 'scrapingOutcome'])}
  const outcome = pm.environment.get('scrapingOutcome');
  const body = { leaseToken: pm.environment.get('integrationLeaseToken'), outcome };
  if (outcome === 'succeeded') { ${guard(['scrapingCustomerJson'])} body.customer = JSON.parse(pm.environment.get('scrapingCustomerJson')); }
  else { ${guard(['scrapingErrorCode', 'scrapingErrorMessage'])} body.code = pm.environment.get('scrapingErrorCode'); body.message = pm.environment.get('scrapingErrorMessage'); }
  pm.request.body.update(JSON.stringify(body));
}`, 'Report only what you verified in Pentana. Do not fabricate an external ID or success. Use unknown after a timeout following submission.'),
  request('Import verified scraped customer observations', 'POST', 'admin/integration/customers/import', 'admin', {}, 201, '', runnerGuard + `
if (pm.environment.get('runScrapingRunnerExamples') === 'true') {
  ${guard(['siteId', 'scrapingCustomerJson'])}
  pm.request.body.update(JSON.stringify({ siteId: pm.environment.get('siteId'), customers: [JSON.parse(pm.environment.get('scrapingCustomerJson'))] }));
}`),
  request('Authorize retry after source verification', 'POST', 'admin/integration/commands/{{integrationCommandId}}/retry', 'admin', {}, 201, '', runnerGuard + `
if (pm.environment.get('runScrapingRunnerExamples') === 'true') {
  ${guard(['integrationRetryNote'])}
  pm.request.body.update(JSON.stringify({ note: pm.environment.get('integrationRetryNote'), confirmedNotApplied: pm.environment.get('confirmedNotApplied') === 'true' }));
}`),
  request('Resolve needs-review after verified source success', 'POST', 'admin/integration/commands/{{integrationCommandId}}/resolve', 'admin', {}, 201, '', runnerGuard + `
if (pm.environment.get('runScrapingRunnerExamples') === 'true') {
  ${guard(['integrationRetryNote', 'scrapingCustomerJson'])}
  pm.request.body.update(JSON.stringify({ note: pm.environment.get('integrationRetryNote'), outcome: 'succeeded', customer: JSON.parse(pm.environment.get('scrapingCustomerJson')) }));
}`),
  request('Set development simulator behavior for the next command', 'POST', 'admin/integration/simulator/behavior', 'admin', {}, 201, '', runnerGuard + `
if (pm.environment.get('runScrapingRunnerExamples') === 'true') {
  ${guard(['siteId', 'simulatorBehavior'])}
  pm.request.body.update(JSON.stringify({ siteId: pm.environment.get('siteId'), behavior: pm.environment.get('simulatorBehavior'), count: 1 }));
}`),
], 'Skipped by default. Manual examples for distinct states/modes: do not run this folder as one sequential workflow. Enable runScrapingRunnerExamples only for the individual request after verifying its prerequisites. Provide normalized scrapingCustomerJson from actual observations. Simulator control applies only in simulated mode. See INTEGRATION-RUNNER.md.');
folder('15 Customer 360 — profile and linked follow-ups', [
  ...['sales', 'service'].map(role => request(role.toUpperCase() + ' customer profile and own follow-ups', 'GET', `customers/{{${role}CustomerId}}?siteId={{siteId}}&limit=10`, role, undefined, 200,
    `const data = pm.response.json();
pm.test('Requested customer returned', () => pm.expect(data.customer.id).to.eql(pm.environment.get('${role}CustomerId')));
pm.test('Default staff sees own follow-ups', () => pm.expect(data.tasks.every(task => task.assigned_to === pm.environment.get('${role}UserId'))).to.eql(true));
pm.test('Pagination provided', () => pm.expect(data.pagination.limit).to.eql(10));`, guard([role + 'Token', role + 'CustomerId', 'siteId']))),
  request('ADMIN profile with team follow-ups', 'GET', 'customers/{{salesCustomerId}}?siteId={{siteId}}&limit=1&offset=0', 'admin', undefined, 200,
    "pm.test('ADMIN can see team follow-ups', () => pm.expect(pm.response.json().taskVisibility).to.eql('team'));", guard(['adminToken', 'salesCustomerId', 'siteId'])),
  request('Next page of linked follow-ups', 'GET', 'customers/{{salesCustomerId}}?siteId={{siteId}}&limit=1&offset=1', 'admin', undefined, 200, '', guard(['adminToken', 'salesCustomerId', 'siteId'])),
  request('Unknown customer is unavailable', 'GET', 'customers/00000000-0000-0000-0000-000000000000?siteId={{siteId}}', 'sales', undefined, 404),
  request('Reject invalid detail page size', 'GET', 'customers/{{salesCustomerId}}?siteId={{siteId}}&limit=101', 'sales', undefined, 400, '', guard(['salesCustomerId', 'siteId'])),
  request('Missing customer detail token is rejected', 'GET', 'customers/{{salesCustomerId}}?siteId={{siteId}}', null, undefined, 401),
  request('Deny staff detail at real second site', 'GET', 'customers/{{salesCustomerId}}?siteId={{foundationSiteId}}', 'sales', undefined, 403, '',
    `if (!pm.environment.get('foundationSiteId')) { pm.execution.skipRequest(); } else { ${guard(['salesCustomerId', 'salesToken'])} }`),
], 'Run after folders 05/06 create confirmed customers and follow-ups. Customers are shared at their authorised site; default staff see only their own linked tasks. The second-site request needs the real fixture from folder 12. Timeline/notes/calls are subsequent increments.');
folder('16 Customer 360 — activity history', [
  ...['sales', 'service'].map(role => request(role.toUpperCase() + ' customer activity', 'GET', `customers/{{${role}CustomerId}}/activity?siteId={{siteId}}&limit=10`, role, undefined, 200,
    "pm.test('Activities returned', () => pm.expect(pm.response.json().activities).to.be.an('array'));\npm.test('Raw audit metadata excluded', () => pm.expect(pm.response.json().activities.every(event => !Object.prototype.hasOwnProperty.call(event, 'metadata'))).to.eql(true));", guard([role + 'Token', role + 'CustomerId', 'siteId']))),
  request('ADMIN team activity page', 'GET', 'customers/{{salesCustomerId}}/activity?siteId={{siteId}}&limit=1', 'admin', undefined, 200, '', guard(['adminToken', 'salesCustomerId', 'siteId'])),
  request('Activity next page', 'GET', 'customers/{{salesCustomerId}}/activity?siteId={{siteId}}&limit=1&offset=1', 'admin', undefined, 200),
  request('Unknown activity customer', 'GET', 'customers/00000000-0000-0000-0000-000000000000/activity?siteId={{siteId}}', 'sales', undefined, 404),
  request('Invalid activity pagination', 'GET', 'customers/{{salesCustomerId}}/activity?siteId={{siteId}}&limit=101', 'sales', undefined, 400),
  request('Unauthenticated activity rejected', 'GET', 'customers/{{salesCustomerId}}/activity?siteId={{siteId}}', null, undefined, 401),
], 'Run after confirmed customer and task workflows. Customer/source events are shared within the authorised site; task events follow current task ownership/team permissions. Notes/calls are next.');
folder('17 My Day — personal and team queues', [
  ...['sales', 'service'].map(role => request(role.toUpperCase() + ' personal My Day', 'GET', 'my-day?siteId={{siteId}}&view=own&limit=10', role, undefined, 200,
    `const data = pm.response.json();
${save('myDayDate', 'data.day.date')}
pm.test('Personal queue belongs to this user', () => pm.expect(data.items.every(item => item.assigned_to === pm.environment.get(roleVariable))).to.eql(true));
pm.test('Only open tasks are included', () => pm.expect(data.items.every(item => !item.completed_at && !item.cancelled_at)).to.eql(true));
pm.test('Counts cover overdue and today', () => pm.expect(data.totals.all).to.eql(data.totals.overdue + data.totals.today));
pm.test('Page respects limit', () => pm.expect(data.items.length <= data.pagination.limit).to.eql(true));`.replace('roleVariable', "'" + role + "UserId'"), guard([role + 'Token', 'siteId']))),
  request('ADMIN team My Day', 'GET', 'my-day?siteId={{siteId}}&view=team&limit=10', 'admin', undefined, 200),
  request('Overdue personal tasks', 'GET', 'my-day?siteId={{siteId}}&bucket=overdue', 'sales', undefined, 200),
  request('Today personal tasks', 'GET', 'my-day?siteId={{siteId}}&bucket=today', 'sales', undefined, 200),
  request('Scheduled call tasks', 'GET', 'my-day?siteId={{siteId}}&bucket=calls', 'sales', undefined, 200),
  request('Schedule a SALES call task', 'POST', 'tasks', 'sales', { siteId: '{{siteId}}', customerId: '{{salesCustomerId}}', title: 'Call customer today', kind: 'call', dueAt: '{{dueAt}}' }, 201, save('myDayCallTaskId', 'pm.response.json().task.id'),
    guard(['salesToken', 'siteId', 'salesCustomerId']) + "\npm.variables.set('dueAt', new Date().toISOString());"),
  request('Read scheduled calls after creation', 'GET', 'my-day?siteId={{siteId}}&bucket=calls', 'sales', undefined, 200),
  request('Selected site-local date', 'GET', 'my-day?siteId={{siteId}}&date={{myDayDate}}&limit=1', 'sales', undefined, 200,
    "pm.test('Selected date returned', () => pm.expect(pm.response.json().day.date).to.eql(pm.environment.get('myDayDate')));", guard(['myDayDate', 'siteId', 'salesToken'])),
  request('My Day next page', 'GET', 'my-day?siteId={{siteId}}&date={{myDayDate}}&limit=1&offset=1', 'sales', undefined, 200,
    "pm.test('Page offset returned', () => pm.expect(pm.response.json().pagination.offset).to.eql(1));", guard(['myDayDate', 'siteId', 'salesToken'])),
  request('Reject unknown queue bucket', 'GET', 'my-day?siteId={{siteId}}&bucket=unknown', 'sales', undefined, 400),
  request('Reject default SALES team visibility', 'GET', 'my-day?siteId={{siteId}}&view=team', 'sales', undefined, 403),
  request('Reject invalid calendar date', 'GET', 'my-day?siteId={{siteId}}&date=2026-02-30', 'sales', undefined, 400),
  request('Reject invalid page size', 'GET', 'my-day?siteId={{siteId}}&limit=101', 'sales', undefined, 400),
  request('Missing My Day authentication', 'GET', 'my-day?siteId={{siteId}}', null, undefined, 401),
], 'Uses the site timezone; defaults to its current date. Calls are scheduled tasks, not recorded calls or actual dialling. Run after folders 05/06. Default SALES team rejection assumes no tasks.view_team extra permission. Completed work is excluded. Source appointments/deliveries are future inputs.');
folder('18 Customer 360 — internal notes and call logging', [
  request('Read shared customer journal', 'GET', 'customers/{{salesCustomerId}}/journal?siteId={{siteId}}&limit=10', 'sales', undefined, 200, '', guard(['salesToken', 'salesCustomerId', 'siteId'])),
  request('Add internal SALES note', 'POST', 'customers/{{salesCustomerId}}/notes', 'sales', { siteId: '{{siteId}}', text: 'Customer prefers a morning callback.' }, 201,
    save('salesNoteId', 'pm.response.json().entry.id'), guard(['salesToken', 'salesCustomerId', 'siteId']) + `\nif (!pm.environment.get('salesNoteKey')) { pm.environment.set('salesNoteKey', 'postman-note-' + Date.now()); }`),
  request('Replay the same note without duplication', 'POST', 'customers/{{salesCustomerId}}/notes', 'sales', { siteId: '{{siteId}}', text: 'Customer prefers a morning callback.' }, 201,
    "pm.test('Existing note returned', () => pm.expect(pm.response.json().entry.id).to.eql(pm.environment.get('salesNoteId')));", guard(['salesNoteKey', 'salesNoteId'])),
  request('Log call with promised callback', 'POST', 'customers/{{salesCustomerId}}/calls', 'sales', { siteId: '{{siteId}}', summary: 'Discussed options and promised a callback.', direction: 'outgoing', outcome: 'connected', followUp: { title: 'Promised customer callback', dueAt: '{{journalFollowUpDueAt}}', priority: 'normal' } }, 201,
    save('salesCallId', 'pm.response.json().entry.id') + '\n' + save('promisedCallTaskId', 'pm.response.json().followUp.id'), guard(['salesToken', 'salesCustomerId', 'siteId']) + `\nif (!pm.environment.get('salesCallKey')) { pm.environment.set('salesCallKey', 'postman-call-' + Date.now()); }
if (!pm.environment.get('journalFollowUpDueAt')) { pm.environment.set('journalFollowUpDueAt', new Date(Date.now() + 3600000).toISOString()); }`),
  request('Replay call and callback without duplication', 'POST', 'customers/{{salesCustomerId}}/calls', 'sales', { siteId: '{{siteId}}', summary: 'Discussed options and promised a callback.', direction: 'outgoing', outcome: 'connected', followUp: { title: 'Promised customer callback', dueAt: '{{journalFollowUpDueAt}}', priority: 'normal' } }, 201,
    "pm.test('Same callback returned', () => pm.expect(pm.response.json().followUp.id).to.eql(pm.environment.get('promisedCallTaskId')));", guard(['salesCallKey', 'journalFollowUpDueAt', 'promisedCallTaskId'])),
  request('SERVICE reads shared SALES customer notes/calls', 'GET', 'customers/{{salesCustomerId}}/journal?siteId={{siteId}}&limit=100', 'service', undefined, 200,
    "pm.test('Call log is site-shared', () => pm.expect(pm.response.json().entries.map(entry => entry.id)).to.include(pm.environment.get('salesCallId')));", guard(['serviceToken', 'salesCustomerId', 'siteId', 'salesCallId'])),
  request('Read Customer 360 timeline with notes/calls', 'GET', 'customers/{{salesCustomerId}}/activity?siteId={{siteId}}&limit=100', 'sales', undefined, 200,
    "pm.test('Note event present', () => pm.expect(pm.response.json().activities.map(event => event.type)).to.include('customer.note_added'));"),
  request('Next journal page', 'GET', 'customers/{{salesCustomerId}}/journal?siteId={{siteId}}&limit=1&offset=1', 'sales', undefined, 200),
  request('Reject missing note idempotency key', 'POST', 'customers/{{salesCustomerId}}/notes', 'sales', { siteId: '{{siteId}}', text: 'No duplicate guard key' }, 400),
  request('Reject note key reuse with changed content', 'POST', 'customers/{{salesCustomerId}}/notes', 'sales', { siteId: '{{siteId}}', text: 'Changed note content' }, 409, '', guard(['salesNoteKey'])),
  request('Reject invalid call outcome', 'POST', 'customers/{{salesCustomerId}}/calls', 'sales', { siteId: '{{siteId}}', summary: 'Attempted call', direction: 'outgoing', outcome: 'invalid' }, 400),
  request('Unauthenticated journal rejected', 'GET', 'customers/{{salesCustomerId}}/journal?siteId={{siteId}}', null, undefined, 401),
], 'Run after confirmed SALES customer creation. Notes/call logs are append-only and site-shared; task references retain ownership permissions. Calls are logs only; no dialling or Pentana write. Clear salesNoteKey/salesCallKey/journalFollowUpDueAt to create another sample instead of replaying. SERVICE request requires same-site access.');
const journalFolder = folders.find(group => group.name.startsWith('18 '));
for (const item of journalFolder.item) {
  if (item.request.method !== 'POST' || item.name.includes('missing note')) continue;
  item.request.header.push({ key: 'Idempotency-Key', value: item.request.url.endsWith('/notes') ? '{{salesNoteKey}}' : '{{salesCallKey}}' });
}
const step3Start = `if (pm.environment.get('runStep3Tests') !== 'true') { pm.execution.skipRequest(); }
else { pm.environment.set('step3SimulationVerified', 'false'); ${guard(['salesToken', 'siteId', 'salesCustomerId'])} }`;
const step3Guard = `if (pm.environment.get('runStep3Tests') !== 'true') { pm.execution.skipRequest(); }
else if (pm.environment.get('step3SimulationVerified') !== 'true') { throw new Error('Run folder 19 simulation verification first. These workflows are simulation-only.'); }`;
const keyed = (item, key) => { item.request.header.push({ key: 'Idempotency-Key', value: '{{' + key + '}}' }); return item; };
const newKey = key => `\npm.environment.set('${key}', 'postman-' + pm.variables.replaceIn('{{$guid}}'));`;
const commandSaved = save('step3CommandId', 'pm.response.json().command.id');
folder('19 Customer 360 — contact edits and consent simulation', [
  request('Verify server simulation before Step 3 mutations', 'GET', 'integration/status', 'sales', undefined, 200,
    `const data = pm.response.json(); if (data.mode !== 'simulated') throw new Error('Step 3 sample workflow requires simulated integration'); pm.environment.set('step3SimulationVerified', 'true');`, step3Start),
  keyed(request('Queue customer contact edit', 'PATCH', 'customers/{{salesCustomerId}}', 'sales', { siteId: '{{siteId}}', firstName: 'Postman Updated' }, 202, commandSaved, step3Guard + newKey('step3EditKey')), 'step3EditKey'),
  request('Read pending command and confirmed profile', 'GET', 'integration/commands/{{step3CommandId}}', 'sales', undefined, 200, '', step3Guard),
  request('Read shared pending customer changes', 'GET', 'customers/{{salesCustomerId}}/changes?siteId={{siteId}}&limit=10', 'service', undefined, 200, '', step3Guard),
  request('Confirm edit through simulator', 'POST', 'admin/integration/commands/{{step3CommandId}}/process', 'admin', {}, 201, '', step3Guard),
  request('Read edited profile', 'GET', 'customers/{{salesCustomerId}}?siteId={{siteId}}', 'sales', undefined, 200,
    "pm.test('Confirmed edit visible', () => pm.expect(pm.response.json().customer.first_name).to.eql('Postman Updated'));", step3Guard),
  keyed(request('Replay identical contact edit', 'PATCH', 'customers/{{salesCustomerId}}', 'sales', { siteId: '{{siteId}}', firstName: 'Postman Updated' }, 202,
    "pm.test('Edit replayed', () => pm.expect(pm.response.json().command.id).to.eql(pm.environment.get('step3CommandId')));", step3Guard), 'step3EditKey'),
  keyed(request('Queue simulation-only email consent', 'PATCH', 'customers/{{salesCustomerId}}/privacy', 'sales', { siteId: '{{siteId}}', privacy: { do_not_contact: false, email: 'granted', sms: 'unknown', call: 'unknown' } }, 202, commandSaved, step3Guard + newKey('step3PrivacyKey')), 'step3PrivacyKey'),
  request('Confirm privacy through simulator', 'POST', 'admin/integration/commands/{{step3CommandId}}/process', 'admin', {}, 201, '', step3Guard),
  request('Read confirmed consent', 'GET', 'customers/{{salesCustomerId}}?siteId={{siteId}}', 'sales', undefined, 200,
    "pm.test('Email consent confirmed', () => pm.expect(pm.response.json().customer.privacy.email).to.eql('granted'));", step3Guard),
  request('ADMIN validates customer reassignment', 'PATCH', 'customers/{{salesCustomerId}}/assignment', 'admin', { siteId: '{{siteId}}', assignedTo: '{{salesUserId}}' }, 200, '', step3Guard),
], 'Optional simulation-only workflow. Set runStep3Tests=true and run after confirmed SALES customer creation. No real Pentana write. Clear the flag after testing. Command statuses expose pending/confirmed/rejected/needs-review results.');
const taskSaved = save('step3TaskId', 'pm.response.json().task.id') + '\n' + save('step3TaskVersion', 'pm.response.json().task.version');
folder('20 Task management — edit reschedule reassign cancel', [
  request('ADMIN discovers active same-site assignees', 'GET', 'sites/{{siteId}}/staff?limit=10&offset=0', 'admin', undefined, 200,
    "pm.test('Assignee profiles are sanitized', () => pm.expect(pm.response.json().staff.every(item => !Object.prototype.hasOwnProperty.call(item, 'email'))).to.eql(true));", step3Guard),
  request('Default SALES cannot enumerate assignees', 'GET', 'sites/{{siteId}}/staff?limit=10', 'sales', undefined, 403, '', step3Guard),
  request('Create disposable follow-up', 'POST', 'tasks', 'sales', { siteId: '{{siteId}}', customerId: '{{salesCustomerId}}', title: 'Step 3 callback', dueAt: '{{dueAt}}' }, 201, taskSaved, step3Guard + "\npm.variables.set('dueAt', new Date().toISOString());"),
  request('Read task version', 'GET', 'tasks/{{step3TaskId}}?siteId={{siteId}}', 'sales', undefined, 200, taskSaved, step3Guard),
  request('Edit and reschedule as a call', 'PATCH', 'tasks/{{step3TaskId}}', 'sales', { siteId: '{{siteId}}', version: 0, title: 'Updated callback', kind: 'call', dueAt: '{{dueAt}}', priority: 'high' }, 200, taskSaved, step3Guard + `\npm.request.body.update(JSON.stringify({ siteId: pm.environment.get('siteId'), version: Number(pm.environment.get('step3TaskVersion')), title: 'Updated callback', kind: 'call', dueAt: new Date().toISOString(), priority: 'high' }));`),
  request('Reject stale task edit', 'PATCH', 'tasks/{{step3TaskId}}', 'sales', { siteId: '{{siteId}}', version: 0, title: 'Stale edit' }, 409, '', step3Guard),
  request('ADMIN reassigns task to SERVICE', 'PATCH', 'tasks/{{step3TaskId}}', 'admin', {}, 200, taskSaved, step3Guard + `\npm.request.body.update(JSON.stringify({ siteId: pm.environment.get('siteId'), version: Number(pm.environment.get('step3TaskVersion')), assignedTo: pm.environment.get('serviceUserId') }));`),
  request('Previous owner cannot read reassigned task', 'GET', 'tasks/{{step3TaskId}}?siteId={{siteId}}', 'sales', undefined, 404, '', step3Guard),
  request('SERVICE sees assigned call in My Day', 'GET', 'my-day?siteId={{siteId}}&bucket=calls', 'service', undefined, 200, '', step3Guard),
  request('SERVICE cancels current task', 'PATCH', 'tasks/{{step3TaskId}}/cancel', 'service', {}, 200, taskSaved, step3Guard + `\npm.request.body.update(JSON.stringify({ siteId: pm.environment.get('siteId'), version: Number(pm.environment.get('step3TaskVersion')), reason: 'Postman disposable test completed' }));`),
  request('Cancelled task cannot be completed', 'PATCH', 'tasks/{{step3TaskId}}/complete?siteId={{siteId}}', 'service', undefined, 400, '', step3Guard),
], 'Run after folder 19 with three same-site test roles. Reassignment validates the new assignee current site access. Cancellation removes work from My Day.');
const messageSaved = save('step3MessageId', 'pm.response.json().message.id') + '\n' + save('step3MessageVersion', 'pm.response.json().message.version');
const simulatedMailGuard = step3Guard + `\nif (pm.environment.get('runStep3Tests') === 'true' && pm.environment.get('messagingSimulationVerified') !== 'true') throw new Error('Run messaging simulation verification first; live SMTP sends are excluded from this collection workflow.');`;
folder('21 Customer messaging — email simulation', [
  request('Verify messaging simulation transport', 'GET', 'messaging/status', 'sales', undefined, 200,
    `pm.environment.set('messagingSimulationVerified', 'false'); const data = pm.response.json(); if (data.mode !== 'simulated') throw new Error('Set MESSAGE_TRANSPORT=simulated for this development workflow'); pm.environment.set('messagingSimulationVerified', 'true');`, step3Guard),
  keyed(request('Create email draft', 'POST', 'customers/{{salesCustomerId}}/messages', 'sales', { siteId: '{{siteId}}', subject: 'Postman customer email', body: 'Simulated customer update only.' }, 201, messageSaved, simulatedMailGuard + newKey('step3DraftKey')), 'step3DraftKey'),
  keyed(request('Replay draft without duplication', 'POST', 'customers/{{salesCustomerId}}/messages', 'sales', { siteId: '{{siteId}}', subject: 'Postman customer email', body: 'Simulated customer update only.' }, 201, '', simulatedMailGuard), 'step3DraftKey'),
  request('Edit email draft', 'PATCH', 'messages/{{step3MessageId}}', 'sales', {}, 200, messageSaved, simulatedMailGuard + `\npm.request.body.update(JSON.stringify({ siteId: pm.environment.get('siteId'), version: Number(pm.environment.get('step3MessageVersion')), body: 'Updated simulation-only customer email.' }));`),
  keyed(request('Explicitly send through simulator', 'POST', 'messages/{{step3MessageId}}/send', 'sales', {}, 202,
    save('step3ProviderId', 'pm.response.json().message.provider_id') + "\npm.test('Accepted, not delivered', () => pm.expect(pm.response.json().message.status).to.eql('accepted'));", simulatedMailGuard + newKey('step3SendKey') + `\npm.request.body.update(JSON.stringify({ siteId: pm.environment.get('siteId'), version: Number(pm.environment.get('step3MessageVersion')) }));`), 'step3SendKey'),
  keyed(request('Replay same send without another submission', 'POST', 'messages/{{step3MessageId}}/send', 'sales', {}, 202, '', simulatedMailGuard + `\npm.request.body.update(JSON.stringify({ siteId: pm.environment.get('siteId'), version: Number(pm.environment.get('step3MessageVersion')) }));`), 'step3SendKey'),
  request('ADMIN records simulation delivery evidence', 'POST', 'messages/{{step3MessageId}}/delivery', 'admin', { siteId: '{{siteId}}', status: 'delivered', providerId: '{{step3ProviderId}}', evidence: 'Simulation-only Postman delivery confirmation' }, 201, '', simulatedMailGuard),
  request('Read paginated customer message outcomes', 'GET', 'customers/{{salesCustomerId}}/messages?siteId={{siteId}}&limit=10', 'sales', undefined, 200, '', simulatedMailGuard),
  request('Read shared timeline with email outcomes', 'GET', 'customers/{{salesCustomerId}}/activity?siteId={{siteId}}&limit=100', 'service', undefined, 200, '', simulatedMailGuard),
], 'Email only. No SMTP credentials belong in Postman. This workflow requires MESSAGE_TRANSPORT=simulated and ALLOW_SIMULATED_INTEGRATION=true. Actual SMTP must be configured separately and sent individually after verified real consent. SMTP accepted is not confirmed inbox delivery. Recovery and resolution APIs are documented in Swagger.');
environment.values.push(...['salesLeadId', 'salesLeadVersion'].map(key => ({ key, value: '', type: 'default', enabled: true })));
folder('25 Sales enquiries', [
  request('Create SALES enquiry with next follow-up', 'POST', 'sales/leads', 'sales', { siteId: '{{siteId}}', customerId: '{{salesCustomerId}}', title: 'Website SUV enquiry', source: 'Website', vehicleInterest: 'Family SUV', followUpAt: '2026-12-01T09:00:00.000Z' }, 201,
    "const lead = pm.response.json().lead; writeVariable('salesLeadId', lead.id); writeVariable('salesLeadVersion', lead.version);", guard(['salesToken', 'siteId', 'salesCustomerId']) + "\npm.request.headers.upsert({ key: 'Idempotency-Key', value: pm.variables.replaceIn('{{$guid}}') });"),
  request('List own SALES enquiries', 'GET', 'sales/leads?siteId={{siteId}}&limit=20&offset=0', 'sales', undefined, 200, "pm.test('Own visibility', () => pm.expect(pm.response.json().visibility).to.eql('own'));", guard(['salesToken', 'siteId'])),
  request('Read SALES enquiry', 'GET', 'sales/leads/{{salesLeadId}}?siteId={{siteId}}', 'sales', undefined, 200, '', guard(['salesToken', 'siteId', 'salesLeadId'])),
  request('Qualify SALES enquiry', 'PATCH', 'sales/leads/{{salesLeadId}}', 'sales', { siteId: '{{siteId}}', version: 0, status: 'qualified' }, 200,
    "writeVariable('salesLeadVersion', pm.response.json().lead.version);", guard(['salesToken', 'siteId', 'salesLeadId', 'salesLeadVersion']) + "\nconst body = JSON.parse(pm.request.body.raw); body.version = Number(readVariable('salesLeadVersion')); pm.request.body.update(JSON.stringify(body));"),
  request('ADMIN team enquiries', 'GET', 'sales/leads?siteId={{siteId}}&limit=20&offset=0', 'admin', undefined, 200, '', guard(['adminToken', 'siteId'])),
  request('SERVICE cannot read Sales enquiries', 'GET', 'sales/leads?siteId={{siteId}}', 'service', undefined, 403, '', guard(['serviceToken', 'siteId'])),
], 'Local Sales enquiries linked to confirmed customers. Optional initial follow-up creates a normal My Day task. Enquiry ownership and existing task ownership are managed independently. Real Pentana scraping is not used.');

folder('26 Sales pipeline and progress', [
  request('Read SALES pipeline counts and first page', 'GET', 'sales/pipeline?siteId={{siteId}}&limit=20&offset=0', 'sales', undefined, 200, '', guard(['salesToken', 'siteId'])),
  request('Read current enquiry version before moving', 'GET', 'sales/leads/{{salesLeadId}}?siteId={{siteId}}', 'sales', undefined, 200, "writeVariable('salesLeadVersion', pm.response.json().lead.version);", guard(['salesToken', 'siteId', 'salesLeadId'])),
  request('Move enquiry to test drive with progress note', 'PATCH', 'sales/pipeline/{{salesLeadId}}/stage', 'sales', { siteId: '{{siteId}}', version: 0, stage: 'test_drive', reason: 'Customer requested a test drive' }, 200,
    "writeVariable('salesLeadVersion', pm.response.json().lead.version);", guard(['salesToken', 'siteId', 'salesLeadId', 'salesLeadVersion']) + "\nconst body = JSON.parse(pm.request.body.raw); body.version = Number(readVariable('salesLeadVersion')); pm.request.body.update(JSON.stringify(body));"),
  request('List test-drive pipeline enquiries', 'GET', 'sales/pipeline?siteId={{siteId}}&stage=test_drive&limit=20', 'sales', undefined, 200, '', guard(['salesToken', 'siteId'])),
  request('Read paginated enquiry progress history', 'GET', 'sales/pipeline/{{salesLeadId}}/history?siteId={{siteId}}&limit=10&offset=0', 'sales', undefined, 200,
    "pm.test('History includes authors and timestamps', () => pm.response.json().history.forEach(event => { pm.expect(event.author.id).to.be.a('string'); pm.expect(event.occurredAt).to.be.a('string'); }));", guard(['salesToken', 'siteId', 'salesLeadId'])),
  request('Reject pipeline move without progress note', 'PATCH', 'sales/pipeline/{{salesLeadId}}/stage', 'sales', { siteId: '{{siteId}}', version: 0, stage: 'won', reason: '' }, 400, '', guard(['salesToken', 'siteId', 'salesLeadId'])),
  request('SERVICE cannot view pipeline', 'GET', 'sales/pipeline?siteId={{siteId}}', 'service', undefined, 403, '', guard(['serviceToken', 'siteId'])),
  request('ADMIN pipeline team view', 'GET', 'sales/pipeline?siteId={{siteId}}&limit=20', 'admin', undefined, 200, '', guard(['adminToken', 'siteId'])),
], 'Run folder 25 first. Pipeline uses local CRM enquiries, optimistic versions and progress notes. Won does not create a deal. Existing closed enquiries remain available; reopen with a documented stage move. Refresh the version before new moves; uncertain retries should be checked in history before resubmission.');

environment.values.push(...['stockBrandId', 'stockVehicleId', 'stockVersion'].map(key => ({ key, value: '', type: 'default', enabled: true })));
folder('27 Stock matching', [
  request('Select a Sales-accessible mapped site brand', 'GET', 'sites/{{siteId}}/brands?limit=100', 'sales', undefined, 200,
    "const brand = pm.response.json().brands.find(item => item.permissions.includes('sales.read')); if (!brand) throw new Error('Map a brand to this site and ensure Sales has brand access before running stock tests.'); writeVariable('stockBrandId', brand.id);", guard(['salesToken', 'siteId'])),
  request('ADMIN add simulated stock vehicle', 'POST', 'sales/stock', 'admin', { siteId: '{{siteId}}', brandId: '{{stockBrandId}}', stockNumber: 'POSTMAN-STOCK', make: 'Kia', model: 'Sportage', year: 2026, odometerKm: 150, bodyType: 'SUV', fuelType: 'Petrol', transmission: 'Automatic', priceCents: 3499000 }, 201,
    "const vehicle = pm.response.json().vehicle; writeVariable('stockVehicleId', vehicle.id); writeVariable('stockVersion', vehicle.version);", guard(['adminToken', 'siteId', 'stockBrandId']) + "\nconst body = JSON.parse(pm.request.body.raw); body.stockNumber = 'POSTMAN-' + pm.variables.replaceIn('{{$guid}}'); pm.request.body.update(JSON.stringify(body)); pm.request.headers.upsert({ key: 'Idempotency-Key', value: pm.variables.replaceIn('{{$guid}}') });"),
  request('SALES filter available SUV stock by price', 'GET', 'sales/stock?siteId={{siteId}}&status=available&bodyType=SUV&maxPriceCents=3500000&limit=12', 'sales', undefined, 200, '', guard(['salesToken', 'siteId'])),
  request('Read stock vehicle details', 'GET', 'sales/stock/{{stockVehicleId}}?siteId={{siteId}}', 'sales', undefined, 200, '', guard(['salesToken', 'siteId', 'stockVehicleId'])),
  request('Refresh enquiry version for shortlist', 'GET', 'sales/leads/{{salesLeadId}}?siteId={{siteId}}', 'sales', undefined, 200, "writeVariable('salesLeadVersion', pm.response.json().lead.version);", guard(['salesToken', 'siteId', 'salesLeadId'])),
  request('Shortlist vehicle against enquiry', 'PATCH', 'sales/leads/{{salesLeadId}}/stock', 'sales', { siteId: '{{siteId}}', version: 0, stockId: '{{stockVehicleId}}', action: 'add', note: 'Matches the requested family SUV' }, 200,
    "writeVariable('salesLeadVersion', pm.response.json().lead.version);", guard(['salesToken', 'siteId', 'salesLeadId', 'stockVehicleId', 'salesLeadVersion']) + "\nconst body = JSON.parse(pm.request.body.raw); body.version = Number(readVariable('salesLeadVersion')); pm.request.body.update(JSON.stringify(body));"),
  request('Read matching note in enquiry history', 'GET', 'sales/pipeline/{{salesLeadId}}/history?siteId={{siteId}}&limit=10', 'sales', undefined, 200, '', guard(['salesToken', 'siteId', 'salesLeadId'])),
  request('SERVICE cannot read Sales stock', 'GET', 'sales/stock?siteId={{siteId}}', 'service', undefined, 403, '', guard(['serviceToken', 'siteId'])),
], 'Development simulation only. Run folders 25–26 first and configure a Sales-accessible mapped brand in Settings. Stock shortlist is advisory and does not reserve a vehicle. Vehicles and enquiries must belong to the same authorised site/mode. Admin stock edits require all editable vehicle fields plus version/status. Real stock scraping is deferred.');

environment.values.push(...['appraisalId', 'appraisalVersion'].map(key => ({ key, value: '', type: 'default', enabled: true })));
folder('28 Trade-in appraisals', [
  request('Create draft trade-in appraisal', 'POST', 'sales/leads/{{salesLeadId}}/appraisals', 'sales', { siteId: '{{siteId}}', make: 'Toyota', model: 'Corolla', year: 2020, odometerKm: 85000, registration: 'TEST123', conditionNotes: 'Good condition, minor bumper scratches' }, 201,
    "const appraisal = pm.response.json().appraisal; writeVariable('appraisalId', appraisal.id); writeVariable('appraisalVersion', appraisal.version);", guard(['salesToken', 'siteId', 'salesLeadId']) + "\npm.request.headers.upsert({ key: 'Idempotency-Key', value: pm.variables.replaceIn('{{$guid}}') });"),
  request('Read enquiry appraisals', 'GET', 'sales/leads/{{salesLeadId}}/appraisals?siteId={{siteId}}&limit=10&offset=0', 'sales', undefined, 200, '', guard(['salesToken', 'siteId', 'salesLeadId'])),
  request('Refresh current appraisal version', 'GET', 'sales/leads/{{salesLeadId}}/appraisals/{{appraisalId}}?siteId={{siteId}}', 'sales', undefined, 200, "writeVariable('appraisalVersion', pm.response.json().appraisal.version);", guard(['salesToken', 'siteId', 'salesLeadId', 'appraisalId'])),
  request('Record internal trade-in valuation', 'PATCH', 'sales/leads/{{salesLeadId}}/appraisals/{{appraisalId}}', 'sales', { siteId: '{{siteId}}', version: 0, make: 'Toyota', model: 'Corolla', year: 2020, odometerKm: 85000, registration: 'TEST123', conditionNotes: 'Good condition, minor bumper scratches', status: 'valued', valuationCents: 1450050, valuationNotes: 'Local estimate based on mileage and inspection' }, 200,
    "writeVariable('appraisalVersion', pm.response.json().appraisal.version);", guard(['salesToken', 'siteId', 'salesLeadId', 'appraisalId', 'appraisalVersion']) + "\nconst body = JSON.parse(pm.request.body.raw); body.version = Number(readVariable('appraisalVersion')); pm.request.body.update(JSON.stringify(body));"),
  request('Read appraisal progress history', 'GET', 'sales/pipeline/{{salesLeadId}}/history?siteId={{siteId}}&limit=10', 'sales', undefined, 200, '', guard(['salesToken', 'siteId', 'salesLeadId'])),
  request('SERVICE cannot read trade-in appraisals', 'GET', 'sales/leads/{{salesLeadId}}/appraisals?siteId={{siteId}}', 'service', undefined, 403, '', guard(['serviceToken', 'siteId', 'salesLeadId'])),
], 'Run folder 25 first with an open enquiry. Appraisals are local internal assessments, not binding offers or source writes. Valued requires an integer-cent AUD valuation and supporting notes; Withdrawn requires a reason. Vehicle editing requires all vehicle fields plus current appraisal version. Appraisal changes also increment the enquiry version; refresh it before pipeline/shortlist edits.');

environment.values.push(...['salesDealId', 'salesDealVersion'].map(key => ({ key, value: '', type: 'default', enabled: true })));
const dealVersionPre = role => guard([`${role}Token`, 'siteId', 'salesLeadId', 'salesDealId', 'salesDealVersion']) + "\nconst body = JSON.parse(pm.request.body.raw); body.version = Number(readVariable('salesDealVersion')); pm.request.body.update(JSON.stringify(body));";
folder('29 Deal proposals and approval', [
  request('Create internal deal proposal with valued trade-in', 'POST', 'sales/leads/{{salesLeadId}}/deals', 'sales', { siteId: '{{siteId}}', stockId: '{{stockVehicleId}}', appraisalId: '{{appraisalId}}', salePriceCents: 3499000, discountCents: 100000, feesCents: 50000, notes: 'Internal proposal; fees entered manually; trade-in uses appraisal' }, 201,
    "const deal = pm.response.json().deal; writeVariable('salesDealId', deal.id); writeVariable('salesDealVersion', deal.version);", guard(['salesToken', 'siteId', 'salesLeadId', 'stockVehicleId', 'appraisalId']) + "\npm.request.headers.upsert({ key: 'Idempotency-Key', value: pm.variables.replaceIn('{{$guid}}') });"),
  request('Read scoped enquiry proposals', 'GET', 'sales/leads/{{salesLeadId}}/deals?siteId={{siteId}}&limit=10', 'sales', undefined, 200, '', guard(['salesToken', 'siteId', 'salesLeadId'])),
  request('Read current deal and capture version', 'GET', 'sales/leads/{{salesLeadId}}/deals/{{salesDealId}}?siteId={{siteId}}', 'sales', undefined, 200, "writeVariable('salesDealVersion', pm.response.json().deal.version);", guard(['salesToken', 'siteId', 'salesLeadId', 'salesDealId'])),
  request('Submit proposal for Admin review', 'PATCH', 'sales/leads/{{salesLeadId}}/deals/{{salesDealId}}/status', 'sales', { siteId: '{{siteId}}', version: 0, action: 'submit', note: 'Pricing ready for internal review' }, 200, "writeVariable('salesDealVersion', pm.response.json().deal.version);", dealVersionPre('sales')),
  request('SALES cannot approve a proposal', 'PATCH', 'sales/leads/{{salesLeadId}}/deals/{{salesDealId}}/status', 'sales', { siteId: '{{siteId}}', version: 0, action: 'approve', note: 'Sales approval is not permitted' }, 403, '', dealVersionPre('sales')),
  request('ADMIN approve internal proposal', 'PATCH', 'sales/leads/{{salesLeadId}}/deals/{{salesDealId}}/status', 'admin', { siteId: '{{siteId}}', version: 0, action: 'approve', note: 'Reviewed pricing and trade-in assessment' }, 200, "writeVariable('salesDealVersion', pm.response.json().deal.version);", dealVersionPre('admin')),
  request('Read approval in progress history', 'GET', 'sales/pipeline/{{salesLeadId}}/history?siteId={{siteId}}&limit=20', 'sales', undefined, 200, '', guard(['salesToken', 'siteId', 'salesLeadId'])),
  request('SERVICE cannot read Sales deals', 'GET', 'sales/leads/{{salesLeadId}}/deals?siteId={{siteId}}', 'service', undefined, 403, '', guard(['serviceToken', 'siteId', 'salesLeadId'])),
], 'Run folders 25, 27 and 28 first with an open enquiry, available stock and a valued appraisal. Proposals are local internal records, not binding agreements/payments/reservations. Stock/appraisal changes require refreshing draft pricing; a submitted proposal must be rejected or cancelled before revising. Admin approval uses sales.approve_deals. Approving does not close the enquiry or change stock availability.');

environment.values.push(...['reservationId', 'reservationVersion', 'reservationExpiresAt'].map(key => ({ key, value: '', type: 'default', enabled: true })));
folder('30 Stock reservations', [
  request('Refresh approved deal version before reservation', 'GET', 'sales/leads/{{salesLeadId}}/deals/{{salesDealId}}?siteId={{siteId}}', 'sales', undefined, 200,
    "const deal = pm.response.json().deal; pm.test('Deal is approved', () => pm.expect(deal.status).to.eql('approved')); writeVariable('salesDealVersion', deal.version);", guard(['salesToken', 'siteId', 'salesLeadId', 'salesDealId'])),
  request('Reserve vehicle for approved deal for 24 hours', 'POST', 'sales/leads/{{salesLeadId}}/deals/{{salesDealId}}/reservations', 'sales', { siteId: '{{siteId}}', dealVersion: 0, expiresAt: '{{reservationExpiresAt}}', note: 'Local stock hold for approved proposal' }, 201,
    "const hold = pm.response.json().reservation; writeVariable('reservationId', hold.id); writeVariable('reservationVersion', hold.version); writeVariable('reservationExpiresAt', hold.expires_at);",
    guard(['salesToken', 'siteId', 'salesLeadId', 'salesDealId', 'salesDealVersion']) + "\nconst body = JSON.parse(pm.request.body.raw); body.dealVersion = Number(readVariable('salesDealVersion')); body.expiresAt = new Date(Date.now() + 86400000).toISOString(); pm.request.body.update(JSON.stringify(body)); pm.request.headers.upsert({ key: 'Idempotency-Key', value: pm.variables.replaceIn('{{$guid}}') });"),
  request('Read reservation history and current hold', 'GET', 'sales/leads/{{salesLeadId}}/deals/{{salesDealId}}/reservations?siteId={{siteId}}&limit=5', 'sales', undefined, 200,
    "pm.test('Current hold is active', () => pm.expect(pm.response.json().active.status).to.eql('active'));", guard(['salesToken', 'siteId', 'salesLeadId', 'salesDealId'])),
  request('Stock detail shows reserved availability without customer disclosure', 'GET', 'sales/stock/{{stockVehicleId}}?siteId={{siteId}}', 'sales', undefined, 200,
    "const vehicle = pm.response.json().vehicle; pm.test('Vehicle is reserved', () => pm.expect(vehicle.availability).to.eql('reserved')); pm.test('Stock summary does not expose customer/deal', () => { pm.expect(vehicle.reservation).not.to.have.property('customerId'); pm.expect(vehicle.reservation).not.to.have.property('dealId'); });", guard(['salesToken', 'siteId', 'stockVehicleId'])),
  request('List reserved stock', 'GET', 'sales/stock?siteId={{siteId}}&status=reserved&limit=12', 'sales', undefined, 200, '', guard(['salesToken', 'siteId'])),
  request('SERVICE cannot read Sales reservations', 'GET', 'sales/leads/{{salesLeadId}}/deals/{{salesDealId}}/reservations?siteId={{siteId}}', 'service', undefined, 403, '', guard(['serviceToken', 'siteId', 'salesLeadId', 'salesDealId'])),
  request('Reject stale reservation release version', 'PATCH', 'sales/leads/{{salesLeadId}}/deals/{{salesDealId}}/reservations/{{reservationId}}/release', 'sales', { siteId: '{{siteId}}', version: 999999, note: 'Intentional stale release check' }, 409, '', guard(['salesToken', 'siteId', 'salesLeadId', 'salesDealId', 'reservationId'])),
  request('Release local reservation', 'PATCH', 'sales/leads/{{salesLeadId}}/deals/{{salesDealId}}/reservations/{{reservationId}}/release', 'sales', { siteId: '{{siteId}}', version: 0, note: 'Postman verification finished; release vehicle' }, 200,
    "writeVariable('reservationVersion', pm.response.json().reservation.version);", guard(['salesToken', 'siteId', 'salesLeadId', 'salesDealId', 'reservationId', 'reservationVersion']) + "\nconst body = JSON.parse(pm.request.body.raw); body.version = Number(readVariable('reservationVersion')); pm.request.body.update(JSON.stringify(body));"),
  request('Read reservation progress events', 'GET', 'sales/pipeline/{{salesLeadId}}/history?siteId={{siteId}}&limit=20', 'sales', undefined, 200, '', guard(['salesToken', 'siteId', 'salesLeadId'])),
], 'Run folder 29 first with an approved proposal and fresh stock/appraisal snapshots. Local reservations expire within 7 days and do not write to Pentana or process payment. Only one active hold is permitted per vehicle. This workflow releases its test hold at the end. Deal cancellation releases its hold atomically. Expiry is enforced on reads, creation and a periodic worker; no TTL deletes audit history.');

environment.values.push(...['deliveryId', 'deliveryVersion', 'deliveryScheduledAt', 'deliveryFixtureVerified'].map(key => ({ key, value: '', type: 'default', enabled: true })));
const deliveryGuard = (role, keys = []) => "if (readVariable('deliveryFixtureVerified') !== 'true') pm.execution.skipRequest();\n" + guard([`${role}Token`, 'siteId', ...keys]);
const deliveryCheckPre = role => deliveryGuard(role, ['deliveryId', 'deliveryVersion']) + "\nconst body = JSON.parse(pm.request.body.raw); body.version = Number(readVariable('deliveryVersion')); pm.request.body.update(JSON.stringify(body));";
const saveDeliveryVersion = "writeVariable('deliveryVersion', pm.response.json().delivery.version);";
folder('31 Delivery checklists and Sales workflow', [
  request('Verify approved simulated proposal for delivery fixture', 'GET', 'sales/leads/{{salesLeadId}}/deals/{{salesDealId}}?siteId={{siteId}}', 'sales', undefined, 200,
    "const deal = pm.response.json().deal; writeVariable('deliveryFixtureVerified', deal.integration_mode === 'simulated' && deal.status === 'approved' ? 'true' : 'false'); writeVariable('salesDealVersion', deal.version); pm.test('Delivery verification uses an approved simulated proposal', () => { pm.expect(deal.integration_mode).to.eql('simulated'); pm.expect(deal.status).to.eql('approved'); });", guard(['salesToken', 'siteId', 'salesLeadId', 'salesDealId'])),
  request('Reserve simulated stock to cover delivery fixture', 'POST', 'sales/leads/{{salesLeadId}}/deals/{{salesDealId}}/reservations', 'sales', { siteId: '{{siteId}}', dealVersion: 0, expiresAt: '', note: 'Test hold covers planned delivery' }, 201,
    "const hold = pm.response.json().reservation; writeVariable('reservationId', hold.id); writeVariable('reservationVersion', hold.version);", deliveryGuard('sales', ['salesLeadId', 'salesDealId', 'salesDealVersion']) + "\nconst body = JSON.parse(pm.request.body.raw); body.dealVersion = Number(readVariable('salesDealVersion')); body.expiresAt = new Date(Date.now() + 86400000).toISOString(); pm.request.body.update(JSON.stringify(body)); pm.request.headers.upsert({ key: 'Idempotency-Key', value: pm.variables.replaceIn('{{$guid}}') });"),
  request('Plan simulated delivery in two hours', 'POST', 'sales/deliveries', 'sales', { siteId: '{{siteId}}', leadId: '{{salesLeadId}}', dealId: '{{salesDealId}}', scheduledAt: '', notes: 'Postman delivery checklist test fixture' }, 201,
    "const plan = pm.response.json().delivery; writeVariable('deliveryId', plan.id); writeVariable('deliveryVersion', plan.version); writeVariable('deliveryScheduledAt', plan.scheduled_at);", deliveryGuard('sales', ['salesLeadId', 'salesDealId']) + "\nconst body = JSON.parse(pm.request.body.raw); body.scheduledAt = new Date(Date.now() + 7200000).toISOString(); pm.request.body.update(JSON.stringify(body)); pm.request.headers.upsert({ key: 'Idempotency-Key', value: pm.variables.replaceIn('{{$guid}}') });"),
  request('SALES confirm documents', 'PATCH', 'sales/deliveries/{{deliveryId}}/checklist', 'sales', { siteId: '{{siteId}}', version: 0, item: 'documents', complete: true, note: 'Test documents reviewed' }, 200, saveDeliveryVersion, deliveryCheckPre('sales')),
  request('SALES cannot verify payment', 'PATCH', 'sales/deliveries/{{deliveryId}}/checklist', 'sales', { siteId: '{{siteId}}', version: 0, item: 'payment_verified', complete: true, note: 'Intentional permission denial test' }, 403, '', deliveryCheckPre('sales')),
  request('SERVICE confirm vehicle preparation', 'PATCH', 'sales/deliveries/{{deliveryId}}/checklist', 'service', { siteId: '{{siteId}}', version: 0, item: 'vehicle_preparation', complete: true, note: 'Test vehicle preparation completed' }, 200, saveDeliveryVersion, deliveryCheckPre('service')),
  request('ADMIN record simulated payment verification', 'PATCH', 'sales/deliveries/{{deliveryId}}/checklist', 'admin', { siteId: '{{siteId}}', version: 0, item: 'payment_verified', complete: true, note: 'SIMULATED-POSTMAN-RECEIPT-REFERENCE' }, 200, saveDeliveryVersion, deliveryCheckPre('admin')),
  request('SALES confirm customer appointment', 'PATCH', 'sales/deliveries/{{deliveryId}}/checklist', 'sales', { siteId: '{{siteId}}', version: 0, item: 'customer_confirmation', complete: true, note: 'Test appointment confirmed; no message sent' }, 200, saveDeliveryVersion, deliveryCheckPre('sales')),
  request('SALES confirm handover pack and readiness', 'PATCH', 'sales/deliveries/{{deliveryId}}/checklist', 'sales', { siteId: '{{siteId}}', version: 0, item: 'handover_pack', complete: true, note: 'Test handover pack prepared' }, 200,
    saveDeliveryVersion + "\npm.test('Delivery is ready', () => pm.expect(pm.response.json().delivery.readiness.ready).to.eql(true));", deliveryCheckPre('sales')),
  request('SERVICE reads readiness without payment evidence', 'GET', 'sales/deliveries/{{deliveryId}}?siteId={{siteId}}', 'service', undefined, 200,
    "const plan = pm.response.json().delivery; pm.test('Payment evidence is restricted', () => pm.expect(plan.checklist.payment_verified.note).to.eql(null));", deliveryGuard('service', ['deliveryId'])),
  request('Read paginated delivery board', 'GET', 'sales/deliveries?siteId={{siteId}}&status=planned&limit=12', 'sales', undefined, 200, '', deliveryGuard('sales')),
  request('Read delivery progress history', 'GET', 'sales/pipeline/{{salesLeadId}}/history?siteId={{siteId}}&limit=100', 'sales', undefined, 200, '', deliveryGuard('sales', ['salesLeadId'])),
  request('Release verification hold after readiness test', 'PATCH', 'sales/leads/{{salesLeadId}}/deals/{{salesDealId}}/reservations/{{reservationId}}/release', 'sales', { siteId: '{{siteId}}', version: 0, note: 'Delivery verification finished; release fixture hold' }, 200,
    "writeVariable('reservationVersion', pm.response.json().reservation.version);", deliveryGuard('sales', ['salesLeadId', 'salesDealId', 'reservationId', 'reservationVersion']) + "\nconst body = JSON.parse(pm.request.body.raw); body.version = Number(readVariable('reservationVersion')); pm.request.body.update(JSON.stringify(body));"),
  request('Readiness falls after reservation release', 'GET', 'sales/deliveries/{{deliveryId}}?siteId={{siteId}}', 'sales', undefined, 200,
    "pm.test('An unreserved delivery is not ready', () => pm.expect(pm.response.json().delivery.readiness.ready).to.eql(false));", deliveryGuard('sales', ['deliveryId'])),
], 'Run folders 25–30 first. This folder only operates when the proposal is marked simulated and approved. Ensure SERVICE has access to its mapped brand; ADMIN can complete preparation instead when no Service test account is available. The flow confirms readiness then releases its test hold, leaving the plan blocked until reserved again. No payment, customer message, final handover, sale or Pentana write-back occurs.');

environment.values.push(...['serviceAppointmentId', 'serviceAppointmentVersion', 'serviceAppointmentBrandId'].map(key => ({ key, value: '', type: 'default', enabled: true })));
environment.values.push(...['workshopResourceId', 'workshopResourceVersion', 'workshopDate', 'workshopStartsAt', 'workshopEndsAt'].map(key => ({ key, value: '', type: 'default', enabled: true })));
const appointmentSave = "const a = pm.response.json().appointment; writeVariable('serviceAppointmentId', a.id); writeVariable('serviceAppointmentVersion', a.version);";
const appointmentPre = guard(['siteId', 'serviceToken', 'serviceAppointmentId', 'serviceAppointmentVersion']) + "\nconst body = JSON.parse(pm.request.body.raw); body.version = Number(readVariable('serviceAppointmentVersion')); pm.request.body.update(JSON.stringify(body));";
folder('32 Service appointments', [
  request('ADMIN create disposable workshop resource', 'POST', 'service/resources', 'admin', { siteId: '{{siteId}}', name: 'POSTMAN TEST Bay', days: [0,1,2,3,4,5,6], openMinute: 0, closeMinute: 1440 }, 201,
    "writeVariable('workshopResourceId', pm.response.json().resource.id); writeVariable('workshopResourceVersion', pm.response.json().resource.version);", guard(['siteId', 'adminToken']) + "\nconst body = JSON.parse(pm.request.body.raw); body.name += ' ' + pm.variables.replaceIn('{{$guid}}'); pm.request.body.update(JSON.stringify(body)); pm.request.headers.upsert({ key: 'Idempotency-Key', value: pm.variables.replaceIn('{{$guid}}') });"),
  request('SERVICE select an accessible mapped brand', 'GET', 'sites/{{siteId}}/brands', 'service', undefined, 200,
    "const brand = pm.response.json().brands.find(item => item.permissions.includes('service.write')); if (!brand) throw new Error('Map a brand to this site and grant SERVICE access before booking.'); writeVariable('serviceAppointmentBrandId', brand.id);", guard(['siteId', 'serviceToken'])),
  request('SERVICE book customer appointment', 'POST', 'service/appointments', 'service',
    { siteId: '{{siteId}}', customerId: '{{serviceCustomerId}}', brandId: '{{serviceAppointmentBrandId}}', resourceId: '{{workshopResourceId}}', title: 'POSTMAN TEST — Scheduled maintenance', vehicle: 'Test vehicle TEST-123', notes: 'Disposable local test booking', startsAt: '', endsAt: '' }, 201, appointmentSave,
    guard(['siteId', 'serviceToken', 'serviceCustomerId', 'serviceAppointmentBrandId', 'workshopResourceId']) + "\nconst body = JSON.parse(pm.request.body.raw); const start = Math.ceil(Date.now() / 900000) * 900000 + 86400000; body.startsAt = new Date(start).toISOString(); body.endsAt = new Date(start + 900000).toISOString(); writeVariable('workshopStartsAt', body.startsAt); writeVariable('workshopEndsAt', body.endsAt); pm.request.body.update(JSON.stringify(body)); pm.request.headers.upsert({ key: 'Idempotency-Key', value: pm.variables.replaceIn('{{$guid}}') });"),
  request('SERVICE read appointment', 'GET', 'service/appointments/{{serviceAppointmentId}}?siteId={{siteId}}', 'service', undefined, 200, appointmentSave, guard(['serviceToken', 'siteId', 'serviceAppointmentId'])),
  request('SERVICE list appointments', 'GET', 'service/appointments?siteId={{siteId}}&status=booked&limit=20', 'service', undefined, 200, '', guard(['serviceToken', 'siteId'])),
  request('SALES cannot read Service appointments', 'GET', 'service/appointments?siteId={{siteId}}', 'sales', undefined, 403, '', guard(['salesToken', 'siteId'])),
  request('SERVICE confirm appointment', 'PATCH', 'service/appointments/{{serviceAppointmentId}}', 'service', { siteId: '{{siteId}}', version: 0, status: 'confirmed' }, 200, appointmentSave, appointmentPre),
  request('SERVICE stale edit is rejected', 'PATCH', 'service/appointments/{{serviceAppointmentId}}', 'service', { siteId: '{{siteId}}', version: 0, notes: 'Intentional stale edit' }, 409, '', guard(['serviceToken', 'siteId', 'serviceAppointmentId'])),
  request('SERVICE reschedule appointment', 'PATCH', 'service/appointments/{{serviceAppointmentId}}', 'service', { siteId: '{{siteId}}', version: 0, startsAt: '', endsAt: '' }, 200,
    appointmentSave + "\npm.test('Rescheduling needs confirmation', () => pm.expect(pm.response.json().appointment.status).to.eql('booked'));",
    appointmentPre + "\nconst rescheduled = JSON.parse(pm.request.body.raw); const start = Math.ceil(Date.now() / 900000) * 900000 + 172800000; rescheduled.startsAt = new Date(start).toISOString(); rescheduled.endsAt = new Date(start + 900000).toISOString(); pm.request.body.update(JSON.stringify(rescheduled));"),
  request('SERVICE read customer appointment history', 'GET', 'customers/{{serviceCustomerId}}/activity?siteId={{siteId}}&limit=100', 'service', undefined, 200, '', guard(['serviceToken', 'siteId', 'serviceCustomerId'])),
  request('SERVICE cancel test appointment', 'PATCH', 'service/appointments/{{serviceAppointmentId}}', 'service', { siteId: '{{siteId}}', version: 0, status: 'cancelled', outcomeNote: 'Postman verification complete' }, 200, appointmentSave, appointmentPre),
  request('SERVICE cannot edit closed appointment', 'PATCH', 'service/appointments/{{serviceAppointmentId}}', 'service', { siteId: '{{siteId}}', version: 0, notes: 'Intentional closed edit' }, 409, '', appointmentPre),
], 'First Service increment: local appointments, not workshop capacity or repair orders. Use a disposable serviceCustomerId and a site-mapped brandId accessible to SERVICE. Run the SERVICE customer workflow first. No notification or source write occurs. Re-running creates a new test booking. Do not use real customer IDs for these sample mutations.');


const workshopGuard = guard(['siteId', 'serviceToken', 'workshopResourceId', 'serviceCustomerId', 'serviceAppointmentBrandId', 'workshopStartsAt', 'workshopEndsAt']);
const capacityBody = { siteId: '{{siteId}}', customerId: '{{serviceCustomerId}}', brandId: '{{serviceAppointmentBrandId}}', resourceId: '{{workshopResourceId}}',
  title: 'POSTMAN TEST Capacity', vehicle: 'TEST vehicle', startsAt: '{{workshopStartsAt}}', endsAt: '{{workshopEndsAt}}' };
const capacityPre = workshopGuard + "\npm.request.headers.upsert({ key: 'Idempotency-Key', value: pm.variables.replaceIn('{{$guid}}') });";
folder('33 Service diary and capacity', [
  request('SERVICE determine site-local test date', 'GET', 'auth/me', 'service', undefined, 200,
    "const site = pm.response.json().sites.find(s => s.id === readVariable('siteId')); if (!site) throw new Error('Selected site is unavailable'); const parts = new Intl.DateTimeFormat('en', { timeZone: site.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(readVariable('workshopStartsAt'))); const p = n => parts.find(v => v.type === n).value; writeVariable('workshopDate', p('year') + '-' + p('month') + '-' + p('day'));", workshopGuard),
  request('SERVICE read workshop resources', 'GET', 'service/resources?siteId={{siteId}}&limit=20', 'service', undefined, 200, '', workshopGuard),
  request('SERVICE book capacity fixture', 'POST', 'service/appointments', 'service', capacityBody, 201, appointmentSave, capacityPre),
  request('Overlapping booking is rejected', 'POST', 'service/appointments', 'service', capacityBody, 409, '', capacityPre),
  request('SERVICE read personal diary', 'GET', 'service/diary?siteId={{siteId}}&date={{workshopDate}}&view=own&limit=20', 'service', undefined, 200,
    "pm.test('Diary contains fixture', () => pm.expect(pm.response.json().appointments.some(a => a.id === readVariable('serviceAppointmentId'))).to.eql(true));", workshopGuard),
  request('SERVICE default team diary denial', 'GET', 'service/diary?siteId={{siteId}}&date={{workshopDate}}&view=team', 'service', undefined, 403, '', workshopGuard),
  request('SERVICE read appointment My Day', 'GET', 'service/my-day?siteId={{siteId}}&date={{workshopDate}}&view=own&bucket=today&limit=20', 'service', undefined, 200,
    "pm.test('My Day contains open fixture', () => pm.expect(pm.response.json().appointments.some(a => a.id === readVariable('serviceAppointmentId'))).to.eql(true));", workshopGuard),
  request('ADMIN read team diary', 'GET', 'service/diary?siteId={{siteId}}&date={{workshopDate}}&view=team&limit=20', 'admin', undefined, 200, '', guard(['adminToken','siteId','workshopDate'])),
  request('Availability hides occupied slot', 'GET', 'service/availability?siteId={{siteId}}&resourceId={{workshopResourceId}}&date={{workshopDate}}&durationMinutes=15&limit=100', 'service', undefined, 200,
    "pm.test('Occupied slot excluded', () => pm.expect(pm.response.json().slots.some(s => s.startsAt === readVariable('workshopStartsAt'))).to.eql(false));", workshopGuard),
  request('Cannot deactivate bay with active bookings', 'PATCH', 'service/resources/{{workshopResourceId}}', 'admin', { siteId: '{{siteId}}', version: 0, active: false }, 409, '',
    guard(['adminToken','siteId','workshopResourceId','workshopResourceVersion']) + "\nconst body = JSON.parse(pm.request.body.raw); body.version = Number(readVariable('workshopResourceVersion')); pm.request.body.update(JSON.stringify(body));"),
  request('Cancel capacity fixture', 'PATCH', 'service/appointments/{{serviceAppointmentId}}', 'service', { siteId: '{{siteId}}', version: 0, status: 'cancelled', outcomeNote: 'Capacity verification complete' }, 200, appointmentSave, appointmentPre),
  request('Availability restores released slot', 'GET', 'service/availability?siteId={{siteId}}&resourceId={{workshopResourceId}}&date={{workshopDate}}&durationMinutes=15&limit=100', 'service', undefined, 200,
    "pm.test('Released slot restored', () => pm.expect(pm.response.json().slots.some(s => s.startsAt === readVariable('workshopStartsAt'))).to.eql(true));", workshopGuard),
], 'Run folder 32 first against disposable local fixtures. SERVICE team denial assumes no service.view_team permission; adjust expected status for a team-enabled account. Capacity blocks overlap across advisors/brands. Counts in /service/my-day are independently scoped and paginated from the task queue. No messages or source writes occur.');


const collection = {
  info: { _postman_id: randomUUID(), name: 'Good Showroom — Supabase Auth and MongoDB CRM',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    description: 'Sample test emails and passwords are prefilled; these accounts do not exist until created. Import the companion environment and supply your Supabase public key and setup key, or use the generated PRIVATE environment. Start the backend on port 4000. For a new installation create the initial account in folder 00, then run folders 01–07 in order, including 02B staff creation. Existing installations must use their actual administrator credentials and skip folder 00. Default userCreationMode=direct creates staff identities and memberships; invitation mode supports existing accounts. Tokens and record IDs are saved automatically. CRM folders create sample data. Optional suspension, email, and refresh requests skip unless enabled. Sample passwords are for disposable testing only. No server secrets or MongoDB connection strings are included in this collection.' },
  variable: environment.values.map(({ key, value }) => ({ key, value, type: 'string' })),
  item: folders,
};
const runtime = `function readVariable(key) {
  const scopes = [pm.variables, pm.environment, pm.collectionVariables, pm.globals];
  for (const scope of scopes) {
    const value = scope.get(key);
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return undefined;
}
function writeVariable(key, value) {
  const scope = pm.environment.has(key) ? pm.environment : pm.collectionVariables;
  scope.set(key, value);
  pm.variables.set(key, value);
}
function unsetVariable(key) {
  pm.environment.unset(key);
  pm.collectionVariables.unset(key);
  pm.variables.unset(key);
}`;
const normalize = `for (const key of ${JSON.stringify(environment.values.map(item => item.key))}) {
  const value = readVariable(key);
  if (value !== undefined) pm.variables.set(key, value);
}`;
for (const group of folders) for (const item of group.item) {
  if (!item.event.some(entry => entry.listen === 'prerequest')) item.event.unshift(event('prerequest', ''));
  for (const entry of item.event) {
    const code = entry.script.exec.join('\n')
      .replaceAll('pm.environment.get(', 'readVariable(')
      .replaceAll('pm.environment.set(', 'writeVariable(')
      .replaceAll('pm.environment.unset(', 'unsetVariable(');
    entry.script.exec = [runtime, ...(entry.listen === 'prerequest' ? [normalize] : []), code].join('\n').split('\n');
    new Script(entry.script.exec.join('\n'), { filename: `${item.name}-${entry.listen}` });
  }
}
mkdirSync('postman', { recursive: true });
writeFileSync('postman/Good-Showroom.postman_collection.json', JSON.stringify(collection, null, 2) + '\n');
writeFileSync('postman/Good-Showroom-Local.postman_environment.json', JSON.stringify(environment, null, 2) + '\n');
if (process.argv.includes('--local')) {
  const settings = parseEnv(readFileSync('.env', 'utf8'));
  const privatePath = 'postman/Good-Showroom-PRIVATE.postman_environment.json';
  const previousValues = existsSync(privatePath)
    ? Object.fromEntries(JSON.parse(readFileSync(privatePath, 'utf8')).values.map(item => [item.key, item.value])) : {};
  const overrides = {
    baseUrl: `http://localhost:${settings.PORT || '4000'}/api`,
    supabaseUrl: (settings.SUPABASE_URL || '').replace(/\/$/, ''),
    supabasePublicKey: settings.SUPABASE_PUBLISHABLE_KEY || settings.SUPABASE_ANON_KEY || '',
    setupKey: settings.INITIAL_SETUP_KEY || '',
    integrationMode: settings.INTEGRATION_MODE || 'disabled',
    runIntegrationTests: settings.INTEGRATION_MODE === 'simulated' ? 'true' : 'false',
  };
  const privateEnvironment = {
    ...environment, id: randomUUID(), name: 'Good Showroom Local — PRIVATE ready to import',
    values: environment.values.map(item => ({ ...item, value: overrides[item.key] ?? previousValues[item.key] ?? item.value })),
  };
  writeFileSync('postman/Good-Showroom-PRIVATE.postman_environment.json', JSON.stringify(privateEnvironment, null, 2) + '\n');
  const missing = ['baseUrl', 'supabaseUrl', 'supabasePublicKey', 'setupKey'].filter(key => !overrides[key]);
  console.log(`Private local environment generated; ${missing.length ? 'missing settings: ' + missing.join(', ') : 'all connection settings populated'}.`);
}
console.log(`Generated ${folders.length} folders, ${folders.reduce((count, group) => count + group.item.length, 0)} requests; all scripts passed JavaScript syntax validation.`);
