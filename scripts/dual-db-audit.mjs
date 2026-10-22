/**
 * Dual Database Audit: Good Showroom + FLWup
 * Read-only inspection of both databases
 */
import { MongoClient } from 'mongodb';

const GS_URI = 'mongodb+srv://abdulahadnauman10_db_user:Neximet123@cluster0.qeczbwo.mongodb.net/';
const GS_DB = 'goodshowroom-pentana';
const FLWUP_URI = 'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/flwup_crm';

const output = [];
function log(msg = '') { console.log(msg); output.push(msg); }

async function auditGoodShowroom() {
  log('╔══════════════════════════════════════════════════════════════╗');
  log('║       GOOD SHOWROOM DATABASE AUDIT (Read-Only)              ║');
  log('╚══════════════════════════════════════════════════════════════╝');
  
  const client = new MongoClient(GS_URI);
  await client.connect();
  const db = client.db(GS_DB);

  // List all collections with counts
  const collections = await db.listCollections().toArray();
  log('\n── ALL COLLECTIONS ──');
  const collCounts = {};
  for (const col of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    const count = await db.collection(col.name).countDocuments();
    collCounts[col.name] = count;
    log(`  ${col.name.padEnd(38)} ${String(count).padStart(6)}`);
  }

  // Organisation & Sites
  log('\n── ORGANISATION ──');
  const orgs = await db.collection('organisations').find({}).toArray();
  for (const org of orgs) log(`  ${org.name} (id: ${org.id})`);

  log('\n── SITES ──');
  const sites = await db.collection('sites').find({}).toArray();
  for (const s of sites) log(`  "${s.name}" (id: ${s.id})`);

  // Detailed breakdowns for key collections
  const breakdownCollections = [
    { name: 'customers', fields: ['source', 'integration_mode'] },
    { name: 'customer_vehicles', fields: ['integration_mode', 'source'] },
    { name: 'sales_leads', fields: ['integration_mode', 'pipeline_stage', 'source'] },
    { name: 'sales_deals', fields: ['integration_mode', 'status', 'source'] },
    { name: 'service_appointments', fields: ['integration_mode', 'status'] },
    { name: 'repair_orders', fields: ['integration_mode', 'status'] },
    { name: 'tasks', fields: ['integration_mode', 'kind'] },
    { name: 'customer_journal', fields: ['integration_mode', 'kind'] },
    { name: 'customer_messages', fields: ['integration_mode', 'status', 'channel'] },
    { name: 'stock_vehicles', fields: ['integration_mode', 'status', 'source'] },
    { name: 'delivery_plans', fields: ['integration_mode', 'status'] },
    { name: 'stock_reservations', fields: ['integration_mode', 'status'] },
    { name: 'trade_in_appraisals', fields: ['integration_mode', 'status'] },
    { name: 'handover_items', fields: ['integration_mode', 'status'] },
    { name: 'workshop_resources', fields: ['active'] },
    { name: 'loan_cars', fields: ['status'] },
  ];

  for (const { name, fields } of breakdownCollections) {
    const count = collCounts[name] ?? 0;
    if (count === 0) continue;
    log(`\n── ${name.toUpperCase()} (${count}) ──`);
    for (const field of fields) {
      const agg = await db.collection(name).aggregate([
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]).toArray();
      log(`  By ${field}:`);
      for (const a of agg) log(`    ${a._id ?? 'null/undefined'}: ${a.count}`);
    }
  }

  // External IDs analysis for customers
  log('\n── CUSTOMER EXTERNAL IDS ──');
  const custWithPentana = await db.collection('customers').countDocuments({ 'external_ids.pentana': { $exists: true, $ne: null } });
  const custWithSim = await db.collection('customers').countDocuments({ 'external_ids.simulated': { $exists: true, $ne: null } });
  const custWithIntExt = await db.collection('customers').countDocuments({ integration_external_id: { $exists: true, $ne: null } });
  log(`  With external_ids.pentana: ${custWithPentana}`);
  log(`  With external_ids.simulated: ${custWithSim}`);
  log(`  With integration_external_id: ${custWithIntExt}`);

  // Sample customers
  log('\n── SAMPLE CUSTOMERS (5) ──');
  const sampleCusts = await db.collection('customers').find({}).limit(5).toArray();
  for (const c of sampleCusts) {
    log(`  ${c.first_name} ${c.last_name} | source=${c.source} | int_mode=${c.integration_mode} | ext_ids=${JSON.stringify(c.external_ids)} | email=${c.email} | phone=${c.phone}`);
  }

  // Sample customer journal
  log('\n── SAMPLE CUSTOMER JOURNAL (3) ──');
  const sampleJournals = await db.collection('customer_journal').find({}).limit(3).toArray();
  for (const j of sampleJournals) {
    log(`  kind=${j.kind} | text=${(j.text || '').slice(0, 80)} | int_mode=${j.integration_mode} | customer_id=${j.customer_id}`);
  }

  // Check for any CSV-imported data markers
  log('\n── CSV/IMPORT MARKERS ──');
  const csvCustomers = await db.collection('customers').countDocuments({ source: 'csv' });
  const pentanaCustomers = await db.collection('customers').countDocuments({ source: 'pentana' });
  const manualCustomers = await db.collection('customers').countDocuments({ source: 'manual' });
  const simCustomers = await db.collection('customers').countDocuments({ source: 'simulated' });
  log(`  CSV customers: ${csvCustomers}`);
  log(`  Pentana customers: ${pentanaCustomers}`);
  log(`  Manual customers: ${manualCustomers}`);
  log(`  Simulated customers: ${simCustomers}`);

  await client.close();
  return collCounts;
}

async function auditFLWup() {
  log('\n\n╔══════════════════════════════════════════════════════════════╗');
  log('║       FLWup DATABASE AUDIT (Read-Only)                      ║');
  log('╚══════════════════════════════════════════════════════════════╝');

  const client = new MongoClient(FLWUP_URI);
  await client.connect();
  const db = client.db(); // default db from connection string

  // List all collections with counts
  const collections = await db.listCollections().toArray();
  log('\n── ALL COLLECTIONS ──');
  const collCounts = {};
  for (const col of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    const count = await db.collection(col.name).countDocuments();
    collCounts[col.name] = count;
    log(`  ${col.name.padEnd(38)} ${String(count).padStart(6)}`);
  }

  // For each non-empty collection, sample a document to understand schema
  log('\n── COLLECTION SCHEMAS (sample documents) ──');
  for (const col of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    const count = collCounts[col.name];
    if (count === 0) continue;
    
    log(`\n  ┌─ ${col.name} (${count} docs) ─`);
    const sample = await db.collection(col.name).findOne({});
    if (sample) {
      const keys = Object.keys(sample);
      log(`  │ Fields (${keys.length}): ${keys.join(', ')}`);
      
      // For relevant collections, show more detail
      const relevantCollections = [
        'customers', 'contacts', 'leads', 'deals', 'conversations',
        'messages', 'notes', 'calls', 'followups', 'follow_ups',
        'appointments', 'vehicles', 'customer_vehicles', 'repair_orders',
        'tasks', 'activities', 'users', 'teams', 'pipelines', 'stages',
        'tags', 'custom_fields', 'automations', 'workflows',
        'opportunities', 'companies', 'organizations', 'accounts'
      ];
      
      if (relevantCollections.some(r => col.name.toLowerCase().includes(r))) {
        // Show field values for important fields
        const importantFields = ['name', 'email', 'phone', 'status', 'type', 'source',
          'first_name', 'last_name', 'firstName', 'lastName', 'fullName', 'full_name',
          'createdAt', 'created_at', 'updatedAt', 'updated_at', 'stage', 'pipeline'];
        log(`  │ Sample values:`);
        for (const f of importantFields) {
          if (sample[f] !== undefined) {
            const val = typeof sample[f] === 'object' ? JSON.stringify(sample[f]) : sample[f];
            const display = String(val).length > 100 ? String(val).slice(0, 100) + '...' : String(val);
            log(`  │   ${f}: ${display}`);
          }
        }
      }
    }
    log(`  └─`);
  }

  // For key collections, get aggregated breakdowns
  const keyBreakdownFields = {
    'customers': ['status', 'source', 'type', 'leadStatus'],
    'contacts': ['status', 'source', 'type', 'leadStatus'],
    'leads': ['status', 'source', 'stage', 'pipeline'],
    'deals': ['status', 'stage', 'pipeline'],
    'conversations': ['status', 'type', 'channel'],
    'messages': ['status', 'type', 'direction', 'channel'],
    'notes': ['type'],
    'calls': ['status', 'direction', 'outcome'],
    'tasks': ['status', 'type'],
    'appointments': ['status', 'type'],
    'activities': ['type', 'activityType'],
  };

  for (const [colName, fields] of Object.entries(keyBreakdownFields)) {
    // Try exact and plural variants
    for (const tryName of [colName, colName + 's']) {
      if (collCounts[tryName] && collCounts[tryName] > 0) {
        log(`\n── ${tryName.toUpperCase()} BREAKDOWNS ──`);
        for (const field of fields) {
          try {
            const agg = await db.collection(tryName).aggregate([
              { $group: { _id: `$${field}`, count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 20 }
            ]).toArray();
            if (agg.length > 0 && agg.some(a => a._id !== null)) {
              log(`  By ${field}:`);
              for (const a of agg) log(`    ${a._id ?? 'null'}: ${a.count}`);
            }
          } catch(e) { /* field doesn't exist */ }
        }
        break;
      }
    }
  }

  // Deeper inspection of contacts/customers - looking for matchable data
  const contactColName = collCounts['contacts'] ? 'contacts' :
                          collCounts['customers'] ? 'customers' : null;
  if (contactColName) {
    log(`\n── ${contactColName.toUpperCase()} DETAILED ANALYSIS ──`);
    const col = db.collection(contactColName);
    
    const withEmail = await col.countDocuments({ $or: [
      { email: { $exists: true, $ne: null, $ne: '' } },
      { 'email.value': { $exists: true } },
      { emails: { $exists: true, $not: { $size: 0 } } }
    ]});
    const withPhone = await col.countDocuments({ $or: [
      { phone: { $exists: true, $ne: null, $ne: '' } },
      { 'phone.value': { $exists: true } },
      { phones: { $exists: true, $not: { $size: 0 } } }
    ]});
    log(`  With email: ${withEmail}`);
    log(`  With phone: ${withPhone}`);

    // Sample 5 records for matching analysis
    log(`  Sample records (5):`);
    const samples = await col.find({}).limit(5).toArray();
    for (const s of samples) {
      const id = s._id;
      const name = s.name || s.full_name || s.fullName || `${s.first_name || s.firstName || ''} ${s.last_name || s.lastName || ''}`.trim() || 'N/A';
      const email = s.email || s.emails?.[0]?.value || s.emails?.[0] || 'N/A';
      const phone = s.phone || s.phones?.[0]?.value || s.phones?.[0] || 'N/A';
      log(`    id=${id} | name=${name} | email=${email} | phone=${phone}`);
    }
  }

  // Look for conversations / messages
  for (const cName of ['conversations', 'messages', 'notes', 'calls', 'activities', 'followups', 'follow_ups']) {
    if (collCounts[cName] && collCounts[cName] > 0) {
      log(`\n── ${cName.toUpperCase()} SAMPLES (3) ──`);
      const samples = await db.collection(cName).find({}).limit(3).toArray();
      for (const s of samples) {
        const keys = Object.keys(s);
        log(`  Fields: ${keys.join(', ')}`);
        // Print a compact summary of each sample
        const summary = {};
        for (const k of keys) {
          if (typeof s[k] === 'string' && s[k].length < 200) summary[k] = s[k];
          else if (typeof s[k] === 'number' || typeof s[k] === 'boolean') summary[k] = s[k];
          else if (s[k] instanceof Date) summary[k] = s[k].toISOString();
          else if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) summary[k] = '{...}';
          else if (Array.isArray(s[k])) summary[k] = `[${s[k].length} items]`;
        }
        log(`  Values: ${JSON.stringify(summary)}`);
        log('  ---');
      }
    }
  }

  await client.close();
  return collCounts;
}

async function main() {
  try {
    const gsCounts = await auditGoodShowroom();
    const flwupCounts = await auditFLWup();

    log('\n\n╔══════════════════════════════════════════════════════════════╗');
    log('║       COMPARISON SUMMARY                                    ║');
    log('╚══════════════════════════════════════════════════════════════╝');
    
    log('\n── Good Showroom Collections ──');
    for (const [name, count] of Object.entries(gsCounts).sort(([a],[b]) => a.localeCompare(b))) {
      log(`  ${name.padEnd(38)} ${String(count).padStart(6)}`);
    }
    
    log('\n── FLWup Collections ──');
    for (const [name, count] of Object.entries(flwupCounts).sort(([a],[b]) => a.localeCompare(b))) {
      log(`  ${name.padEnd(38)} ${String(count).padStart(6)}`);
    }

    // Write the full output to a file
    const fs = await import('node:fs');
    fs.writeFileSync('audit-output.txt', output.join('\n'), 'utf8');
    log('\nAudit output written to audit-output.txt');

  } catch (err) {
    console.error('Audit failed:', err);
    process.exit(1);
  }
}

main();
