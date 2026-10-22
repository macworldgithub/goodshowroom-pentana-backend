import { MongoClient } from 'mongodb';

const GS_URI = 'mongodb+srv://abdulahadnauman10_db_user:Neximet123@cluster0.qeczbwo.mongodb.net/';
const GS_DB = 'goodshowroom-pentana';
const FLWUP_URI = 'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/flwup_crm';

async function analyze() {
  const gsClient = new MongoClient(GS_URI);
  const flwupClient = new MongoClient(FLWUP_URI);
  await gsClient.connect();
  await flwupClient.connect();

  const gsDb = gsClient.db(GS_DB);
  const flwupDb = flwupClient.db();

  console.log('====================================');
  console.log('EXACT FLWUP CUSTOMER DEDUPLICATION');
  console.log('====================================');

  const leads = await flwupDb.collection('leads').find({}).toArray();
  console.log(`Total leads fetched: ${leads.length}`);

  // Customer matching strategy:
  // Normalize phone (strip non-digits, e.g. +614... -> 04...)
  function normPhone(p) {
    if (!p) return null;
    let digits = String(p).replace(/\D/g, '');
    if (digits.startsWith('61') && digits.length === 11) digits = '0' + digits.slice(2);
    return digits.length >= 8 ? digits : null;
  }
  function normEmail(e) {
    if (!e) return null;
    const clean = String(e).trim().toLowerCase();
    return clean.includes('@') ? clean : null;
  }

  const customerGroups = []; // Array of { emails: Set, phones: Set, pentanaIds: Set, leadIds: [], names: Set }
  const phoneToGroup = new Map();
  const emailToGroup = new Map();
  const pentanaToGroup = new Map();

  for (const l of leads) {
    const email = normEmail(l.customer_email);
    const phone = normPhone(l.customer_phone);
    const pId = l.pentana_id?.trim() || null;
    const name = l.customer_name?.trim() || 'Unknown';

    // Find any existing group
    let group = null;
    if (pId && pentanaToGroup.has(pId)) group = pentanaToGroup.get(pId);
    else if (email && emailToGroup.has(email)) group = emailToGroup.get(email);
    else if (phone && phoneToGroup.has(phone)) group = phoneToGroup.get(phone);

    if (!group) {
      group = {
        id: l._id.toString(),
        emails: new Set(),
        phones: new Set(),
        pentanaIds: new Set(),
        names: new Set(),
        dealerships: new Set(),
        leadIds: [],
        firstCreated: l.created_at || l.createdAt,
        latestUpdated: l.updatedAt || l.created_at,
      };
      customerGroups.push(group);
    }

    if (email) {
      group.emails.add(email);
      emailToGroup.set(email, group);
    }
    if (phone) {
      group.phones.add(phone);
      phoneToGroup.set(phone, group);
    }
    if (pId) {
      group.pentanaIds.add(pId);
      pentanaToGroup.set(pId, group);
    }
    group.names.add(name);
    if (l.dealership_name) group.dealerships.add(l.dealership_name);
    group.leadIds.push(l._id.toString());
  }

  console.log(`Total unique customer clusters identified: ${customerGroups.length}`);
  const multiLeadCustomers = customerGroups.filter(g => g.leadIds.length > 1);
  console.log(`Customers with multiple leads (>1): ${multiLeadCustomers.length}`);
  const customersWithPentana = customerGroups.filter(g => g.pentanaIds.size > 0);
  console.log(`Customers with verified Pentana ID: ${customersWithPentana.length}`);

  // Check call outcomes in leads
  let leadsWithCallDetails = 0;
  let totalCallsCount = 0;
  let totalConnectedCalls = 0;
  const outcomeCounts = {};

  for (const l of leads) {
    const calls = l.channels?.calls;
    if (calls && calls.count > 0) {
      leadsWithCallDetails++;
      totalCallsCount += (calls.count || 0);
      totalConnectedCalls += (calls.connected || 0);
      const outcome = calls.last_outcome || 'unknown';
      outcomeCounts[outcome] = (outcomeCounts[outcome] || 0) + 1;
    }
  }

  console.log('\n--- CALL ACTIVITY SUMMARY ---');
  console.log(`Leads with recorded call activity: ${leadsWithCallDetails}`);
  console.log(`Total calls made across leads: ${totalCallsCount}`);
  console.log(`Total connected calls: ${totalConnectedCalls}`);
  console.log('Call outcomes:', outcomeCounts);

  // Check vehicles attached to leads
  let leadsWithMakeModel = 0;
  const makeCounts = {};
  for (const l of leads) {
    if (l.vehicle_make) {
      leadsWithMakeModel++;
      makeCounts[l.vehicle_make] = (makeCounts[l.vehicle_make] || 0) + 1;
    }
  }
  console.log('\n--- VEHICLES SUMMARY ---');
  console.log(`Leads with vehicle interest/assigned: ${leadsWithMakeModel}`);
  console.log('Vehicle makes:', makeCounts);

  // Check lead status breakdown
  const statusCounts = {};
  for (const l of leads) {
    statusCounts[l.status] = (statusCounts[l.status] || 0) + 1;
  }
  console.log('\n--- LEAD STATUS BREAKDOWN ---');
  console.log(statusCounts);

  // Check Good Showroom sites and how dealerships map
  console.log('\n--- DEALERSHIP TO SITE MAPPING ---');
  const gsSites = await gsDb.collection('sites').find({}).toArray();
  for (const d of ['BYD South Morang', 'Chery South Morang', 'South Morang Hyundai', 'South Morang Kia']) {
    console.log(`Dealership "${d}":`);
    const count = leads.filter(l => l.dealership_name === d).length;
    console.log(`  Count: ${count}`);
  }

  await gsClient.close();
  await flwupClient.close();
}

analyze().catch(console.error);
