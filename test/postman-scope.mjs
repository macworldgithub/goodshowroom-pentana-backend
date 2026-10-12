import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const collection = JSON.parse(readFileSync('postman/Good-Showroom.postman_collection.json', 'utf8'));
const login = collection.item.find(group => group.name.startsWith('01 ')).item[0];
function scope(values = {}) {
  const map = new Map(Object.entries(values));
  return { get: key => map.get(key), has: key => map.has(key), set: (key, value) => map.set(key, value), unset: key => map.delete(key) };
}
function fixture(environmentValues, collectionValues, globalValues = {}) {
  const environment = scope(environmentValues);
  const collectionVariables = scope(collectionValues);
  const globals = scope(globalValues);
  const local = scope();
  let submittedBody;
  const pm = {
    environment, collectionVariables, globals,
    variables: { ...local, get: key => local.has(key) ? local.get(key) : environment.has(key) ? environment.get(key) : collectionVariables.has(key) ? collectionVariables.get(key) : globals.get(key) },
    request: { body: { update: raw => { submittedBody = JSON.parse(raw); } } },
    execution: { skipRequest: () => { throw new Error('Unexpected skipped login'); } },
    response: { code: 200, to: { have: { status: value => assert.equal(value, 200) } },
      json: () => ({ access_token: 'fake-access-token', refresh_token: 'fake-refresh-token', user: { id: 'fake-user-id' } }) },
    test: (_name, run) => run(),
    expect: value => ({ to: { be: { a: type => assert.equal(typeof value, type) } } }),
  };
  return { pm, environment, collectionVariables, body: () => submittedBody };
}

const credentials = { supabaseUrl: 'https://example.supabase.co', supabasePublicKey: 'fake-public-key', adminEmail: 'admin@example.test', adminPassword: 'test-password-with-"-quotes' };
for (const [name, env, coll, global] of [
  ['collection only', {}, credentials, {}],
  ['environment only', { ...credentials, adminToken: '' }, {}, {}],
  ['empty environment falls back to collection', { supabaseUrl: '', supabasePublicKey: '', adminEmail: '', adminPassword: '', adminToken: '' }, credentials, {}],
  ['global fallback', {}, {}, credentials],
]) {
  const test = fixture(env, coll, global);
  runInNewContext(login.event.find(entry => entry.listen === 'prerequest').script.exec.join('\n'), { pm: test.pm });
  assert.equal(test.pm.variables.get('supabasePublicKey'), credentials.supabasePublicKey);
  assert.equal(test.body().email, credentials.adminEmail);
  assert.equal(test.body().password, credentials.adminPassword);
  runInNewContext(login.event.find(entry => entry.listen === 'test').script.exec.join('\n'), { pm: test.pm });
  assert.equal(test.pm.variables.get('adminToken'), 'fake-access-token');
  const saved = test.environment.has('adminToken') ? test.environment : test.collectionVariables;
  assert.equal(saved.get('adminToken'), 'fake-access-token');
  console.log(`PASS ${name}: login variables resolved and token saved`);
}
const missing = fixture({}, { ...credentials, supabasePublicKey: '' });
assert.throws(() => runInNewContext(login.event.find(entry => entry.listen === 'prerequest').script.exec.join('\n'), { pm: missing.pm }), /collection: supabasePublicKey$/);
console.log('PASS missing key diagnostic names only the missing key');
