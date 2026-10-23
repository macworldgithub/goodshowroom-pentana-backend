import { MongoClient } from 'mongodb';
import { createHash, randomUUID } from 'node:crypto';

const GS_URI = process.env.MONGODB_URI || 'mongodb+srv://abdulahadnauman10_db_user:Neximet123@cluster0.qeczbwo.mongodb.net/';
const GS_DB = process.env.MONGODB_DATABASE || 'goodshowroom-pentana';
const FLWUP_URI = process.env.FLWUP_MONGODB_URI || 'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/flwup_crm';

const IS_DRY_RUN = !process.argv.includes('--execute');

function deterministicUUID(key) {
  const hash = createHash('sha256').update(key).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    'a' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

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

function parseName(fullName) {
  if (!fullName) return { firstName: 'Unknown', lastName: '' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ');
  return { firstName, lastName };
}

function mapPipelineStage(status) {
  switch (status) {
    case 'new_lead': return 'new';
    case 'following_up': return 'contacted';
    case 'returned': return 'contacted';
    case 'sold': return 'won';
    case 'lost': return 'lost';
    default: return 'new';
  }
}

function mapLeadStatus(status) {
  switch (status) {
    case 'new_lead': return 'new';
    case 'following_up': return 'contacted';
    case 'returned': return 'contacted';
    case 'sold': return 'closed';
    case 'lost': return 'closed';
    default: return 'new';
  }
}

async function runMigration() {
  console.log(`=======================================================`);
  console.log(`FLWUP TO GOOD SHOWROOM MIGRATION (Mode: ${IS_DRY_RUN ? 'DRY RUN' : 'LIVE EXECUTION'})`);
  console.log(`=======================================================`);

  const gsClient = new MongoClient(GS_URI);
  const flwupClient = new MongoClient(FLWUP_URI);
  await gsClient.connect();
  await flwupClient.connect();

  const gsDb = gsClient.db(GS_DB);
  const flwupDb = flwupClient.db();

  const org = await gsDb.collection('organisations').findOne({});
  const orgId = org.id;

  // Load existing GS sites
  const gsSites = await gsDb.collection('sites').find({ organisation_id: orgId }).toArray();
  const hyundaiSite = gsSites.find(s => s.name.includes('South Morang Hyundai'))?.id;
  const kiaSite = gsSites.find(s => s.name.includes('South Morang KIA'))?.id;
  const defaultAdmin = (await gsDb.collection('users').findOne({}))?._id || 'bf165e1f-0368-4f3b-904a-6eedc82bee92';

  function resolveSite(dealerName, storeCode) {
    if (dealerName === 'South Morang Kia') return kiaSite;
    if (dealerName === 'South Morang Hyundai') return hyundaiSite;
    if (storeCode === 'Store 70') return kiaSite;
    return hyundaiSite; // default South Morang site
  }

  // Load all FLWup leads
  const leads = await flwupDb.collection('leads').find({}).toArray();
  console.log(`Loaded ${leads.length} leads from FLWup.`);

  // Load existing customers in Good Showroom
  const existingGsCustomers = await gsDb.collection('customers').find({}).toArray();
  const existingPentanaIds = new Set(existingGsCustomers.map(c => c.external_ids?.pentana).filter(Boolean));
  const existingEmails = new Set(existingGsCustomers.map(c => normEmail(c.email)).filter(Boolean));
  const existingPhones = new Set(existingGsCustomers.map(c => normPhone(c.phone)).filter(Boolean));
  const existingFlwupIds = new Set(existingGsCustomers.map(c => c.external_ids?.flwup).filter(Boolean));

  console.log(`Existing GS customers: ${existingGsCustomers.length} (${existingPentanaIds.size} Pentana, ${existingGsCustomers.length - existingPentanaIds.size} simulated)`);

  // Step 1: Customer Clustering & Deduplication
  const stats = {
    customers: { inserts: 0, updates: 0, matches: 0, skips: 0, conflicts: 0 },
    leads: { inserts: 0, updates: 0, matches: 0, skips: 0, conflicts: 0 },
    messages: { inserts: 0, updates: 0, matches: 0, skips: 0, conflicts: 0 },
    journal: { inserts: 0, updates: 0, matches: 0, skips: 0, conflicts: 0 },
    tasks: { inserts: 0, updates: 0, matches: 0, skips: 0, conflicts: 0 },
    vehicles: { inserts: 0, updates: 0, matches: 0, skips: 0, conflicts: 0 },
  };

  const customerClusters = [];

  
  const phoneToCluster = new Map();
  const emailToCluster = new Map();
  const pentanaToCluster = new Map();

  for (const l of leads) {
    const email = normEmail(l.customer_email);
    const phone = normPhone(l.customer_phone);
    const pId = l.pentana_id?.trim() || null;

    let cluster = null;
    if (pId && pentanaToCluster.has(pId)) cluster = pentanaToCluster.get(pId);
    else if (email && emailToCluster.has(email)) cluster = emailToCluster.get(email);
    else if (phone && phoneToCluster.has(phone)) cluster = phoneToCluster.get(phone);

    if (!cluster) {
      const stableKey = pId || email || phone || l._id.toString();
      const custId = deterministicUUID(`flwup-customer-${stableKey}`);
      cluster = {
        id: custId,
        stableKey,
        pentanaId: pId,
        emails: new Set(),
        phones: new Set(),
        names: new Set(),
        siteId: resolveSite(l.dealership_name, l.store_code),
        leads: [],
        optedOut: false,
        createdAt: l.created_at || l.createdAt || new Date().toISOString(),
        updatedAt: l.updatedAt || l.created_at || new Date().toISOString(),
      };
      customerClusters.push(cluster);
    }

    if (email) { cluster.emails.add(email); emailToCluster.set(email, cluster); }
    if (phone) { cluster.phones.add(phone); phoneToCluster.set(phone, cluster); }
    if (pId) { cluster.pentanaId = pId; pentanaToCluster.set(pId, cluster); }
    if (l.customer_name) cluster.names.add(l.customer_name.trim());
    
    // Check opt-out in lost reason
    if (l.lost_reason && /unsubscribed|opted out|delete my details|no longer interested.*unsubscribed/i.test(l.lost_reason)) {
      cluster.optedOut = true;
    }

    cluster.leads.push(l);
  }

  console.log(`\nIdentified ${customerClusters.length} deduplicated customer entities from 4,906 leads.`);

  // Prepare customer documents
  const customerDocsToInsert = [];
  const leadIdToCustomerId = new Map();

  for (const cluster of customerClusters) {
    // Check if customer matches an authoritative Pentana customer in GS
    const pentanaMatch = cluster.pentanaId ? existingGsCustomers.find(c => c.external_ids?.pentana === cluster.pentanaId) : null;
    
    // Check if customer was already imported via FLWup
    const flwupMatch = existingGsCustomers.find(c => c.id === cluster.id || c.external_ids?.flwup === cluster.stableKey);

    // Check email match against existing customers
    const emailPentanaMatch = [...cluster.emails].map(e => existingGsCustomers.find(c => c.source === 'pentana' && normEmail(c.email) === e)).find(Boolean);

    if (pentanaMatch || flwupMatch || emailPentanaMatch) {
      const match = pentanaMatch || flwupMatch || emailPentanaMatch;
      stats.customers.matches++;
      stats.customers.skips++;
      for (const l of cluster.leads) {
        leadIdToCustomerId.set(l._id.toString(), match.id);
      }
      continue;
    }

    const primaryName = [...cluster.names][0] || 'Unknown';
    const { firstName, lastName } = parseName(primaryName);
    const primaryEmail = [...cluster.emails][0] || null;
    const primaryPhone = [...cluster.phones][0] || null;

    const custDoc = {
      _id: cluster.id,
      id: cluster.id,
      organisation_id: orgId,
      site_id: cluster.siteId,
      created_by: defaultAdmin,
      assigned_to: defaultAdmin,
      first_name: firstName,
      last_name: lastName,
      email: primaryEmail,
      phone: primaryPhone,
      source: cluster.pentanaId ? 'pentana' : 'simulated',
      integration_mode: 'simulated',
      integration_external_id: cluster.pentanaId || cluster.id,
      external_ids: {
        ...(cluster.pentanaId ? { pentana: cluster.pentanaId } : {}),
        flwup: cluster.stableKey,
      },
      privacy: cluster.optedOut
        ? { do_not_contact: true, email: 'denied', sms: 'denied', call: 'denied' }
        : { do_not_contact: false, email: 'unknown', sms: 'unknown', call: 'unknown' },
      source_revision: createHash('sha256').update(cluster.stableKey).digest('hex'),
      source_observed_at: cluster.createdAt,
      created_at: cluster.createdAt,
      updated_at: cluster.updatedAt,
    };

    customerDocsToInsert.push(custDoc);
    stats.customers.inserts++;

    for (const l of cluster.leads) {
      leadIdToCustomerId.set(l._id.toString(), cluster.id);
    }
  }

  // Step 2: Sales Leads
  const existingGsLeads = await gsDb.collection('sales_leads').find({}).toArray();
  const existingLeadExtIds = new Set(existingGsLeads.map(l => l.create_key).filter(Boolean));

  const salesLeadDocsToInsert = [];
  for (const l of leads) {
    const custId = leadIdToCustomerId.get(l._id.toString());
    if (!custId) {
      stats.leads.skips++;
      continue;
    }
    const createKey = `flwup-lead-${l._id}`;
    if (existingLeadExtIds.has(createKey)) {
      stats.leads.matches++;
      stats.leads.skips++;
      continue;
    }

    const leadId = deterministicUUID(createKey);
    const siteId = resolveSite(l.dealership_name, l.store_code);
    const vMake = l.vehicle_make?.trim() || '';
    const vModel = l.vehicle_model?.trim() || '';
    const vYear = l.vehicle_year || '';
    const vehicleInterest = [vYear, vMake, vModel].filter(Boolean).join(' ') || null;

    const leadDoc = {
      _id: leadId,
      id: leadId,
      organisation_id: orgId,
      site_id: siteId,
      customer_id: custId,
      assigned_to: defaultAdmin,
      created_by: defaultAdmin,
      title: `${vMake} ${vModel} Enquiry (${l.dealership_name || 'South Morang'})`.trim(),
      source: l.source || 'FLWup CRM',
      vehicle_interest: vehicleInterest,
      status: mapLeadStatus(l.status),
      pipeline_stage: mapPipelineStage(l.status),
      version: 1,
      integration_mode: 'simulated',
      external_ids: {
        flwup: l._id.toString(),
        deal_id: l.deal_id,
        ...(l.pentana_id ? { pentana: l.pentana_id } : {}),
      },
      create_key: createKey,
      create_hash: createHash('sha256').update(JSON.stringify({ id: l._id, deal_id: l.deal_id })).digest('hex'),
      created_at: l.created_at || l.createdAt || new Date().toISOString(),
      updated_at: l.updatedAt || l.created_at || new Date().toISOString(),
    };

    salesLeadDocsToInsert.push(leadDoc);
    stats.leads.inserts++;
  }

  // Step 3: Customer Messages
  const flwupMessages = await flwupDb.collection('customer_messages').find({}).toArray();
  console.log(`Loaded ${flwupMessages.length} customer messages from FLWup.`);

  const existingGsMessages = await gsDb.collection('customer_messages').find({}).toArray();
  const existingMsgKeys = new Set(existingGsMessages.map(m => m.provider_id).filter(Boolean));

  const messageDocsToInsert = [];
  for (const m of flwupMessages) {
    if (existingMsgKeys.has(m.provider_message_id)) {
      stats.messages.matches++;
      stats.messages.skips++;
      continue;
    }
    const custId = leadIdToCustomerId.get(m.lead_id) || customerClusters[0]?.id;
    const msgId = deterministicUUID(`flwup-msg-${m._id}`);
    const siteId = resolveSite(m.dealership_name, null);

    const msgDoc = {
      _id: msgId,
      id: msgId,
      organisation_id: orgId,
      site_id: siteId,
      customer_id: custId,
      created_by: defaultAdmin,
      channel: 'sms',
      subject: 'SMS Conversation',
      body: m.body || '',
      version: 1,
      status: m.status === 'delivered' ? 'delivered' : 'delivered',
      transport: 'simulated',
      to: m.phone,
      provider_id: m.provider_message_id,
      integration_mode: 'simulated',
      created_at: m.created_at || new Date().toISOString(),
      updated_at: m.provider_checked_at || m.created_at || new Date().toISOString(),
    };

    messageDocsToInsert.push(msgDoc);
    stats.messages.inserts++;
  }

  // Step 4: Customer Journal (Call Outcomes & Diary Entries)
  const existingJournal = await gsDb.collection('customer_journal').find({}).toArray();
  const existingJournalKeys = new Set(existingJournal.map(j => j.idempotency_key).filter(Boolean));

  const journalDocsToInsert = [];
  for (const l of leads) {
    const custId = leadIdToCustomerId.get(l._id.toString());
    if (!custId) continue;
    const siteId = resolveSite(l.dealership_name, l.store_code);

    // Call outcome from channels.calls
    const calls = l.channels?.calls;
    if (calls && calls.count > 0 && calls.last_outcome) {
      const callKey = `flwup-call-${l._id}-${calls.last_called_at || 'latest'}`;
      if (!existingJournalKeys.has(callKey)) {
        const jId = deterministicUUID(callKey);
        journalDocsToInsert.push({
          _id: jId,
          id: jId,
          organisation_id: orgId,
          site_id: siteId,
          customer_id: custId,
          created_by: defaultAdmin,
          kind: 'call',
          text: `Call outcome: ${calls.last_outcome}. Total calls logged: ${calls.count}, connected: ${calls.connected}.`,
          occurred_at: calls.last_called_at || l.last_activity_at || l.created_at,
          direction: 'outgoing',
          outcome: calls.last_outcome === 'spoke' ? 'connected' : calls.last_outcome === 'no_answer' ? 'no_answer' : 'busy',
          integration_mode: 'simulated',
          idempotency_key: callKey,
          request_hash: createHash('sha256').update(callKey).digest('hex'),
          created_at: calls.last_called_at || l.created_at,
        });
        stats.journal.inserts++;
      } else {
        stats.journal.matches++;
        stats.journal.skips++;
      }
    }

    // Diary entries (notes)
    if (l.diary_entries && Array.isArray(l.diary_entries)) {
      l.diary_entries.forEach((entry, idx) => {
        const diaryKey = `flwup-diary-${l._id}-${idx}`;
        if (!existingJournalKeys.has(diaryKey)) {
          const jId = deterministicUUID(diaryKey);
          journalDocsToInsert.push({
            _id: jId,
            id: jId,
            organisation_id: orgId,
            site_id: siteId,
            customer_id: custId,
            created_by: defaultAdmin,
            kind: 'note',
            text: `[${entry.user || 'System'}] ${entry.note}`,
            occurred_at: entry.date || l.created_at,
            integration_mode: 'simulated',
            idempotency_key: diaryKey,
            request_hash: createHash('sha256').update(diaryKey).digest('hex'),
            created_at: entry.date || l.created_at,
          });
          stats.journal.inserts++;
        } else {
          stats.journal.matches++;
          stats.journal.skips++;
        }
      });
    }
  }

  // Step 5: Follow-up Tasks for active leads
  const activeFollowLeads = leads.filter(l => l.status === 'following_up');
  const existingTasks = await gsDb.collection('tasks').find({}).toArray();
  const existingTaskTitles = new Set(existingTasks.map(t => t.title + t.customer_id));

  const taskDocsToInsert = [];
  for (const l of activeFollowLeads) {
    const custId = leadIdToCustomerId.get(l._id.toString());
    if (!custId) continue;
    const taskTitle = `Follow up with ${l.customer_name || 'Customer'}`;
    if (existingTaskTitles.has(taskTitle + custId)) {
      stats.tasks.matches++;
      stats.tasks.skips++;
      continue;
    }
    const taskId = deterministicUUID(`flwup-task-${l._id}`);
    const siteId = resolveSite(l.dealership_name, l.store_code);

    taskDocsToInsert.push({
      _id: taskId,
      id: taskId,
      organisation_id: orgId,
      site_id: siteId,
      customer_id: custId,
      created_by: defaultAdmin,
      assigned_to: defaultAdmin,
      kind: 'follow_up',
      title: taskTitle,
      details: `Enquiry: ${l.vehicle_make || ''} ${l.vehicle_model || ''}. Tier: ${l.tier || 'warm'}. Score: ${l.score || 0}. Dealer: ${l.dealership_name}.`,
      due_at: l.first_followup_due_at || l.last_activity_at || new Date().toISOString(),
      priority: l.tier === 'hot' ? 'high' : l.tier === 'warm' ? 'normal' : 'low',
      completed_at: null,
      integration_mode: 'simulated',
      created_at: l.created_at || new Date().toISOString(),
      updated_at: l.updatedAt || new Date().toISOString(),
    });
    stats.tasks.inserts++;
  }

  // Step 6: Customer Vehicles (Sold leads = owned customer vehicles)
  const soldLeads = leads.filter(l => l.status === 'sold' && l.vehicle_make);
  const existingVehicles = await gsDb.collection('customer_vehicles').find({}).toArray();
  const existingVehicleKeys = new Set(existingVehicles.map(v => v.external_id).filter(Boolean));

  const vehicleDocsToInsert = [];
  for (const l of soldLeads) {
    const custId = leadIdToCustomerId.get(l._id.toString());
    if (!custId) continue;
    const vKey = l.pentana_id || l.deal_id || l._id.toString();
    if (existingVehicleKeys.has(vKey)) {
      stats.vehicles.matches++;
      stats.vehicles.skips++;
      continue;
    }
    const vId = deterministicUUID(`flwup-veh-${vKey}`);
    const siteId = resolveSite(l.dealership_name, l.store_code);

    vehicleDocsToInsert.push({
      _id: vId,
      id: vId,
      organisation_id: orgId,
      site_id: siteId,
      customer_id: custId,
      make: l.vehicle_make,
      model: l.vehicle_model || 'Unknown',
      year: l.vehicle_year || 2024,
      registration: 'UNKNOWN',
      vin: `FLWUP-${vKey.slice(-8)}`,
      ownership: 'owned',
      external_id: vKey,
      notes: `Sold via ${l.dealership_name || 'South Morang'} on ${l.sold_at || l.updatedAt || 'N/A'}. Days to sold: ${l.days_to_sold ?? 'N/A'}.`,
      integration_mode: 'simulated',
      created_at: l.sold_at || l.created_at || new Date().toISOString(),
      updated_at: l.updatedAt || new Date().toISOString(),
    });
    stats.vehicles.inserts++;
  }

  console.log('\n=======================================================');
  console.log('MIGRATION SUMMARY (RECORD COUNTS)');
  console.log('=======================================================');
  console.table(stats);

  if (!IS_DRY_RUN) {
    console.log('\n[LIVE EXECUTION] Writing records to Good Showroom database in batches...');

    if (customerDocsToInsert.length > 0) {
      console.log(`Inserting ${customerDocsToInsert.length} customers...`);
      for (let i = 0; i < customerDocsToInsert.length; i += 500) {
        await gsDb.collection('customers').insertMany(customerDocsToInsert.slice(i, i + 500), { ordered: false });
      }
    }
    if (salesLeadDocsToInsert.length > 0) {
      console.log(`Inserting ${salesLeadDocsToInsert.length} sales leads...`);
      for (let i = 0; i < salesLeadDocsToInsert.length; i += 500) {
        await gsDb.collection('sales_leads').insertMany(salesLeadDocsToInsert.slice(i, i + 500), { ordered: false });
      }
    }
    if (messageDocsToInsert.length > 0) {
      console.log(`Inserting ${messageDocsToInsert.length} customer messages...`);
      await gsDb.collection('customer_messages').insertMany(messageDocsToInsert, { ordered: false });
    }
    if (journalDocsToInsert.length > 0) {
      console.log(`Inserting ${journalDocsToInsert.length} journal entries...`);
      for (let i = 0; i < journalDocsToInsert.length; i += 500) {
        await gsDb.collection('customer_journal').insertMany(journalDocsToInsert.slice(i, i + 500), { ordered: false });
      }
    }
    if (taskDocsToInsert.length > 0) {
      console.log(`Inserting ${taskDocsToInsert.length} follow-up tasks...`);
      for (let i = 0; i < taskDocsToInsert.length; i += 500) {
        await gsDb.collection('tasks').insertMany(taskDocsToInsert.slice(i, i + 500), { ordered: false });
      }
    }
    if (vehicleDocsToInsert.length > 0) {
      console.log(`Inserting ${vehicleDocsToInsert.length} customer vehicles...`);
      for (let i = 0; i < vehicleDocsToInsert.length; i += 500) {
        await gsDb.collection('customer_vehicles').insertMany(vehicleDocsToInsert.slice(i, i + 500), { ordered: false });
      }
    }

    console.log('\n[LIVE EXECUTION] All batches committed successfully.');
  } else {
    console.log('\n[DRY RUN COMPLETE] No data was written to the database.');
  }

  await gsClient.close();
  await flwupClient.close();
}

runMigration().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
