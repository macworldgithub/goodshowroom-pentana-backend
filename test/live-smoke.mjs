import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { createClient } from '@supabase/supabase-js';
import { AppModule } from '../dist/app.module.js';

// Checks configured services without printing secrets or modifying customer/staff records.
// Starting the application creates its normal MongoDB indexes if they are missing.
if (existsSync('.env')) process.loadEnvFile('.env');
let app;
let failed = false;
const report = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed = true;
};
const sanitizedMessage = error => {
  let message = String(error?.message ?? 'No diagnostic message');
  const sensitive = Object.entries(process.env).filter(([name]) => /KEY|TOKEN|SECRET|PASSWORD|URI|URL/i.test(name)).map(([, value]) => value);
  try {
    const uri = new URL(process.env.MONGODB_URI);
    sensitive.push(uri.username, uri.password, decodeURIComponent(uri.username), decodeURIComponent(uri.password));
  } catch { /* Invalid URI is diagnosed without displaying it. */ }
  for (const value of sensitive.filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.split(value).join('[redacted]');
  }
  return message.replace(/(?:mongodb(?:\+srv)?|https?):\/\/\S+/gi, '[redacted URL]').slice(0, 400);
};

try {
  const url = process.env.SUPABASE_URL;
  const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !publicKey) {
    report('Supabase configuration', false, 'URL and public key are required');
  } else {
    const client = createClient(url, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.getUser('deliberately-invalid-smoke-test-token');
    report('Supabase Auth reachable', Boolean(error && error.name === 'AuthApiError' && [400, 401, 403].includes(error.status)),
      error ? `response status ${error.status ?? 'unavailable'}` : 'unexpected token acceptance');
    if (secretKey) {
      const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: adminError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
      report('Supabase admin credentials', !adminError, adminError ? `response status ${adminError.status ?? 'unavailable'}` : 'read-only identity check');
    } else {
      console.log('SKIP Supabase admin credentials: invitation emails require a server-only key');
    }
  }
} catch {
  report('Supabase connection', false, 'connection or key configuration could not be verified');
}

try {
  app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  report('MongoDB connection and backend startup', true, 'transaction support and indexes verified');
  const baseUrl = await app.getUrl();
  for (const path of ['auth/me', 'customers', 'admin/memberships', 'auth/invitations']) {
    const response = await fetch(`${baseUrl}/api/${path}`);
    report(`Unauthenticated ${path}`, response.status === 401, `HTTP ${response.status}`);
  }
  const response = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: 'Bearer deliberately-invalid-smoke-test-token' },
  });
  report('Invalid session rejected', response.status === 401, `HTTP ${response.status}`);
} catch (error) {
  const safeCode = typeof error?.code === 'string' || typeof error?.code === 'number' ? String(error.code).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : 'unavailable';
  const replicaRequired = error?.message === 'MongoDB must be a replica set or Atlas cluster to support transactions';
  const authenticationFailed = /authentication failed|bad auth|AuthenticationFailed/i.test(error?.message ?? '');
  report('MongoDB connection and backend startup', false,
    replicaRequired ? 'Use MongoDB Atlas or enable a local replica set' : authenticationFailed
      ? 'Database authentication failed: check the database username/password and authSource in MONGODB_URI'
      : `error code ${safeCode}; ${sanitizedMessage(error)}`);
} finally {
  await app?.close();
}

console.log('Live sign-in and email delivery need a real staff session; these checks do not send emails.');
process.exitCode = failed ? 1 : 0;
