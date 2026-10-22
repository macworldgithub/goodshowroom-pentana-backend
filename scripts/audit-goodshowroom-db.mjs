/**
 * Audit script: Inspect Good Showroom MongoDB collections
 * Counts, source analysis, integration_mode breakdown, external_id analysis
 */
import { MongoClient } from 'mongodb';

const MONGODB_URI = 'mongodb+srv://abdulahadnauman10_db_user:Neximet123@cluster0.qeczbwo.mongodb.net/';
const MONGODB_DATABASE = 'goodshowroom-pentana';

async function audit() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DATABASE);

  console.log('=== GOOD SHOWROOM DATABASE AUDIT ===');
  console.log('Database:', MONGODB_DATABASE);
  console.log('Timestamp:', new Date().toISOString());

  // List all collections
  const collections = await db.listCollections().toArray();
  console.log('\n--- ALL COLLECTIONS ---');
  for (const col of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    const count = await db.collection(col.name).countDocuments();
    console.log(`  ${col.name.padEnd(35)} ${String(count).padStart(6)}`);
  }

  // Organisation
  console.log('\n--- ORGANISATION ---');
  const orgs = await db.collection('organisations').find({}).toArray();
  for (const org of orgs) {
    console.log(`  ${org.name} (id: ${org.id})`);
  }

  // Sites
  console.log('\n--- SITES ---');
  const sites = await db.collection('sites').find({}).toArray();
  for (const s of sites) {
    console.log(`  "${s.name}" (id: ${s.id}) | brands: ${s.brand_ids?.length ?? 0}`);
  }

  // Brands count
  const brandCount = await db.collection('brands').countDocuments();
  console.log('\n--- BRANDS ---');
  console.log('Total brands:', brandCount);

  // Users
  console.log('\n--- USERS ---');
  const users = await db.collection('users').find({}).toArray();
  for (const u of users) {
    console.log(`  ${u.email || 'no-email'} | ${u.full_name || 'no-name'} (id: ${u._id})`);
  }

  // Memberships
  const membershipCount = await db.collection('memberships').countDocuments();
  console.log('\n--- MEMBERSHIPS ---');
  console.log('Total:', membershipCount);
  const membershipsByRole = await db.collection('memberships').aggregate([
    { $group: { _id: '$role', count: { $sum: 1 } } }
  ]).toArray();
  for (const m of membershipsByRole) console.log(`  ${m._id}: ${m.count}`);

  // CUSTOMERS - detailed breakdown
  console.log('\n--- CUSTOMERS ---');
  const custTotal = await db.collection('customers').countDocuments();
  console.log('Total:', custTotal);

  const custBySource = await db.collection('customers').aggregate([
    { $group: { _id: '$source', count: { $sum: 1 } } }
  ]).toArray();
  console.log('By source:');
  for (const c of custBySource) console.log(`  ${c._id}: ${c.count}`);

  const custByIntMode = await db.collection('customers').aggregate([
    { $group: { _id: '$integration_mode', count: { $sum: 1 } } }
  ]).toArray();
  console.log('By integration_mode:');
  for (const c of custByIntMode) console.log(`  ${c._id || 'null/undefined'}: ${c.count}`);

  // Check external_ids patterns
  const custWithPentanaId = await db.collection('customers').countDocuments({ 'external_ids.pentana': { $exists: true, $ne: null } });
  const custWithSimId = await db.collection('customers').countDocuments({ 'external_ids.simulated': { $exists: true, $ne: null } });
  const custWithExtId = await db.collection('customers').countDocuments({ integration_external_id: { $exists: true, $ne: null } });
  console.log(`With external_ids.pentana: ${custWithPentanaId}`);
  console.log(`With external_ids.simulated: ${custWithSimId}`);
  console.log(`With integration_external_id: ${custWithExtId}`);

  // Sample a few customers to see structure
  console.log('\nSample customers (first 3):');
  const sampleCusts = await db.collection('customers').find({}).limit(3).toArray();
  for (const c of sampleCusts) {
    console.log(`  ${c.first_name} ${c.last_name} | source: ${c.source} | int_mode: ${c.integration_mode} | ext_ids: ${JSON.stringify(c.external_ids)} | int_ext_id: ${c.integration_external_id || 'none'}`);
  }

  // CUSTOMER VEHICLES
  console.log('\n--- CUSTOMER VEHICLES ---');
  const cvTotal = await db.collection('customer_vehicles').countDocuments();
  console.log('Total:', cvTotal);
  const cvByMode = await db.collection('customer_vehicles').aggregate([
    { $group: { _id: '$integration_mode', count: { $sum: 1 } } }
  ]).toArray();
  console.log('By integration_mode:');
  for (const c of cvByMode) console.log(`  ${c._id || 'null'}: ${c.count}`);

  // SALES LEADS
  console.log('\n--- SALES LEADS ---');
  const leadTotal = await db.collection('sales_leads').countDocuments();
  console.log('Total:', leadTotal);
  const leadsByStage = await db.collection('sales_leads').aggregate([
    { $group: { _id: '$pipeline_stage', count: { $sum: 1 } } }
  ]).toArray();
  console.log('By pipeline_stage:');
  for (const l of leadsByStage) console.log(`  ${l._id}: ${l.count}`);
  const leadsByMode = await db.collection('sales_leads').aggregate([
    { $group: { _id: '$integration_mode', count: { $sum: 1 } } }
  ]).toArray();
  console.log('By integration_mode:');
  for (const l of leadsByMode) console.log(`  ${l._id || 'null'}: ${l.count}`);

  // SERVICE APPOINTMENTS
  console.log('\n--- SERVICE APPOINTMENTS ---');
  const apptTotal = await db.collection('service_appointments').countDocuments();
  console.log('Total:', apptTotal);
  const apptsByMode = await db.collection('service_appointments').aggregate([
    { $group: { _id: '$integration_mode', count: { $sum: 1 } } }
  ]).toArray();
  console.log('By integration_mode:');
  for (const a of apptsByMode) console.log(`  ${a._id || 'null'}: ${a.count}`);

  // REPAIR ORDERS
  console.log('\n--- REPAIR ORDERS ---');
  const roTotal = await db.collection('repair_orders').countDocuments();
  console.log('Total:', roTotal);
  const rosByMode = await db.collection('repair_orders').aggregate([
    { $group: { _id: '$integration_mode', count: { $sum: 1 } } }
  ]).toArray();
  console.log('By integration_mode:');
  for (const r of rosByMode) console.log(`  ${r._id || 'null'}: ${r.count}`);

  // TASKS
  console.log('\n--- TASKS ---');
  const taskTotal = await db.collection('tasks').countDocuments();
  console.log('Total:', taskTotal);
  const tasksByMode = await db.collection('tasks').aggregate([
    { $group: { _id: '$integration_mode', count: { $sum: 1 } } }
  ]).toArray();
  console.log('By integration_mode:');
  for (const t of tasksByMode) console.log(`  ${t._id || 'null'}: ${t.count}`);

  // CUSTOMER JOURNAL
  console.log('\n--- CUSTOMER JOURNAL ---');
  const journalTotal = await db.collection('customer_journal').countDocuments();
  console.log('Total:', journalTotal);
  const journalByMode = await db.collection('customer_journal').aggregate([
    { $group: { _id: '$integration_mode', count: { $sum: 1 } } }
  ]).toArray();
  console.log('By integration_mode:');
  for (const j of journalByMode) console.log(`  ${j._id || 'null'}: ${j.count}`);
  const journalByKind = await db.collection('customer_journal').aggregate([
    { $group: { _id: '$kind', count: { $sum: 1 } } }
  ]).toArray();
  console.log('By kind:');
  for (const j of journalByKind) console.log(`  ${j._id}: ${j.count}`);

  // CUSTOMER MESSAGES
  console.log('\n--- CUSTOMER MESSAGES ---');
  const msgTotal = await db.collection('customer_messages').countDocuments();
  console.log('Total:', msgTotal);
  const msgByStatus = await db.collection('customer_messages').aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();
  console.log('By status:');
  for (const m of msgByStatus) console.log(`  ${m._id}: ${m.count}`);

  // SALES DEALS
  console.log('\n--- SALES DEALS ---');
  const dealTotal = await db.collection('sales_deals').countDocuments();
  console.log('Total:', dealTotal);
  const dealsByStatus = await db.collection('sales_deals').aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();
  console.log('By status:');
  for (const d of dealsByStatus) console.log(`  ${d._id}: ${d.count}`);

  // STOCK VEHICLES
  console.log('\n--- STOCK VEHICLES ---');
  const stockTotal = await db.collection('stock_vehicles').countDocuments();
  console.log('Total:', stockTotal);
  const stockByStatus = await db.collection('stock_vehicles').aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();
  console.log('By status:');
  for (const s of stockByStatus) console.log(`  ${s._id}: ${s.count}`);
  const stockBySource = await db.collection('stock_vehicles').aggregate([
    { $group: { _id: '$source', count: { $sum: 1 } } }
  ]).toArray();
  console.log('By source:');
  for (const s of stockBySource) console.log(`  ${s._id}: ${s.count}`);

  // DELIVERY PLANS
  console.log('\n--- DELIVERY PLANS ---');
  const dpTotal = await db.collection('delivery_plans').countDocuments();
  console.log('Total:', dpTotal);

  // STOCK RESERVATIONS
  console.log('\n--- STOCK RESERVATIONS ---');
  const resTotal = await db.collection('stock_reservations').countDocuments();
  console.log('Total:', resTotal);

  // TRADE-IN APPRAISALS
  console.log('\n--- TRADE-IN APPRAISALS ---');
  const taTotal = await db.collection('trade_in_appraisals').countDocuments();
  console.log('Total:', taTotal);

  // HANDOVER ITEMS
  console.log('\n--- HANDOVER ITEMS ---');
  const hiTotal = await db.collection('handover_items').countDocuments();
  console.log('Total:', hiTotal);

  // WORKSHOP RESOURCES
  console.log('\n--- WORKSHOP RESOURCES ---');
  const wrTotal = await db.collection('workshop_resources').countDocuments();
  console.log('Total:', wrTotal);

  // LOAN CARS
  console.log('\n--- LOAN CARS ---');
  const lcTotal = await db.collection('loan_cars').countDocuments();
  console.log('Total:', lcTotal);

  // INTEGRATION COMMANDS
  console.log('\n--- INTEGRATION COMMANDS ---');
  const cmdTotal = await db.collection('integration_commands').countDocuments();
  console.log('Total:', cmdTotal);
  if (cmdTotal > 0) {
    const cmdByStatus = await db.collection('integration_commands').aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]).toArray();
    console.log('By status:');
    for (const c of cmdByStatus) console.log(`  ${c._id}: ${c.count}`);
  }

  // SIMULATED SOURCE RECORDS
  console.log('\n--- SIMULATED SOURCE RECORDS ---');
  const simTotal = await db.collection('simulated_source_records').countDocuments();
  console.log('Total:', simTotal);

  // AUDIT EVENTS
  console.log('\n--- AUDIT EVENTS ---');
  const auditTotal = await db.collection('audit_events').countDocuments();
  console.log('Total:', auditTotal);

  // ACTIVITY MIRROR COMMANDS
  console.log('\n--- ACTIVITY MIRROR COMMANDS ---');
  const amTotal = await db.collection('activity_mirror_commands').countDocuments();
  console.log('Total:', amTotal);

  // SIMULATED SOURCE ACTIVITIES
  console.log('\n--- SIMULATED SOURCE ACTIVITIES ---');
  const ssaTotal = await db.collection('simulated_source_activities').countDocuments();
  console.log('Total:', ssaTotal);

  // CUSTOMER RELATIONSHIPS
  console.log('\n--- CUSTOMER RELATIONSHIPS ---');
  const crTotal = await db.collection('customer_relationships').countDocuments();
  console.log('Total:', crTotal);

  // SERVICE RECOVERY RESOLUTIONS
  console.log('\n--- SERVICE RECOVERY RESOLUTIONS ---');
  const srrTotal = await db.collection('service_recovery_resolutions').countDocuments();
  console.log('Total:', srrTotal);

  await client.close();
  console.log('\n=== AUDIT COMPLETE ===');
}

audit().catch(err => { console.error('Audit failed:', err); process.exit(1); });
