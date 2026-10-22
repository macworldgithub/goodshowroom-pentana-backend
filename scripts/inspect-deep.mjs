import { MongoClient } from 'mongodb';

const GS_URI = 'mongodb+srv://abdulahadnauman10_db_user:Neximet123@cluster0.qeczbwo.mongodb.net/';
const GS_DB = 'goodshowroom-pentana';
const FLWUP_URI = 'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/flwup_crm';

async function main() {
  const gsClient = new MongoClient(GS_URI);
  const flwupClient = new MongoClient(FLWUP_URI);
  await gsClient.connect();
  await flwupClient.connect();

  const gsDb = gsClient.db(GS_DB);
  const flwupDb = flwupClient.db();

  console.log('--- FLWUP PENTANA ID ANALYSIS ---');
  const pIds = await flwupDb.collection('leads').distinct('pentana_id', { pentana_id: { $exists: true, $ne: null, $ne: '' } });
  console.log('Total distinct pentana_ids in FLWup:', pIds.length);
  const samplePIds = pIds.slice(0, 10);
  console.log('Sample pentana_ids in FLWup:', samplePIds);

  const gsPentanaCusts = await gsDb.collection('customers').find({ source: 'pentana' }).toArray();
  const gsPentanaIds = gsPentanaCusts.map(c => c.external_ids?.pentana);
  console.log('GS Pentana Customer IDs (all 30):', gsPentanaIds);

  // Check if stripped (e.g. without PENTANA-) matches
  const strippedFLWup = new Set(pIds.map(p => String(p).replace(/^PENTANA-/i, '')));
  let strippedMatch = 0;
  for (const id of gsPentanaIds) {
    if (strippedFLWup.has(String(id))) strippedMatch++;
  }
  console.log('Match when stripping PENTANA-:', strippedMatch);

  // Check external_lead_id format in FLWup
  const extLeadIds = await flwupDb.collection('leads').distinct('external_lead_id', { external_lead_id: { $exists: true, $ne: null, $ne: '' } });
  console.log('\nTotal distinct external_lead_ids in FLWup:', extLeadIds.length);
  console.log('Sample external_lead_ids:', extLeadIds.slice(0, 10));

  // Check deal_id format in FLWup
  const dealIds = await flwupDb.collection('leads').distinct('deal_id', { deal_id: { $exists: true, $ne: null, $ne: '' } });
  console.log('\nTotal distinct deal_ids in FLWup:', dealIds.length);
  console.log('Sample deal_ids:', dealIds.slice(0, 5));

  // Check deal_ids against GS sales_deals
  const gsDeals = await gsDb.collection('sales_deals').find({}).toArray();
  console.log('GS Sales Deals count:', gsDeals.length);
  const gsDealIds = new Set(gsDeals.map(d => d.id || d._id));
  const gsDealExtIds = new Set(gsDeals.map(d => d.integration_external_id || d.external_ids?.pentana).filter(Boolean));
  let dealMatch = 0;
  for (const d of dealIds) {
    if (gsDealIds.has(d) || gsDealExtIds.has(d)) dealMatch++;
  }
  console.log('FLWup deal_id matches in GS sales_deals:', dealMatch);

  // Check sales_leads in GS
  const gsLeads = await gsDb.collection('sales_leads').find({}).toArray();
  console.log('\nGS Sales Leads count:', gsLeads.length);
  const gsLeadIds = new Set(gsLeads.map(l => l.id || l._id));
  const gsLeadExtIds = new Set(gsLeads.map(l => l.integration_external_id || l.external_ids?.pentana).filter(Boolean));
  console.log('Sample GS Lead ext IDs:', [...gsLeadExtIds].slice(0, 5));

  // Check diary entries across all FLWup leads
  console.log('\n--- DIARY ENTRIES ANALYSIS ---');
  const diaryTypes = await flwupDb.collection('leads').aggregate([
    { $unwind: '$diary_entries' },
    { $group: { _id: '$diary_entries.user', count: { $sum: 1 } } }
  ]).toArray();
  console.log('Diary entries by user:');
  for (const dt of diaryTypes) console.log(`  ${dt._id}: ${dt.count}`);

  const totalDiaryEntries = await flwupDb.collection('leads').aggregate([
    { $unwind: '$diary_entries' },
    { $count: 'total' }
  ]).toArray();
  console.log('Total individual diary entries across all leads:', totalDiaryEntries[0]?.total || 0);

  // Sample notes from diary entries
  const sampleNotes = await flwupDb.collection('leads').aggregate([
    { $unwind: '$diary_entries' },
    { $sample: { size: 10 } }
  ]).toArray();
  console.log('\nSample diary notes:');
  for (const sn of sampleNotes) {
    console.log(`  [${sn.diary_entries.date}] ${sn.diary_entries.user}: ${sn.diary_entries.note?.slice(0, 100)}`);
  }

  // Check if there are non-"System" notes
  const nonSystemNotes = await flwupDb.collection('leads').aggregate([
    { $unwind: '$diary_entries' },
    { $match: { 'diary_entries.user': { $ne: 'System' } } },
    { $count: 'total' }
  ]).toArray();
  console.log('Non-system diary entries:', nonSystemNotes[0]?.total || 0);

  if (nonSystemNotes[0]?.total > 0) {
    const samplesNonSystem = await flwupDb.collection('leads').aggregate([
      { $unwind: '$diary_entries' },
      { $match: { 'diary_entries.user': { $ne: 'System' } } },
      { $limit: 5 }
    ]).toArray();
    console.log('Sample non-system diary entries:');
    for (const sns of samplesNonSystem) {
      console.log(`  [${sns.diary_entries.date}] ${sns.diary_entries.user}: ${sns.diary_entries.note}`);
    }
  }

  // Check customer messages details
  console.log('\n--- CUSTOMER MESSAGES IN FLWUP ---');
  const msgs = await flwupDb.collection('customer_messages').find({}).toArray();
  console.log('Total FLWup customer_messages:', msgs.length);
  for (const m of msgs) {
    console.log(JSON.stringify(m, null, 2));
  }

  // Rooftop vs Site mapping analysis
  console.log('\n--- ROOFTOPS TO GS SITES MAPPING ---');
  const rooftops = await flwupDb.collection('rooftops').find({}).toArray();
  for (const r of rooftops) {
    const match = await gsDb.collection('sites').findOne({ name: { $regex: r.name, $options: 'i' } });
    console.log(`FLWup Rooftop "${r.name}" (${r.id}) -> GS Site: ${match ? `"${match.name}" (${match.id})` : 'NO MATCH'}`);
  }

  // Also check leads dealership_name distribution
  console.log('\n--- LEADS BY DEALERSHIP_NAME ---');
  const leadsByDealer = await flwupDb.collection('leads').aggregate([
    { $group: { _id: '$dealership_name', count: { $sum: 1 } } }
  ]).toArray();
  for (const d of leadsByDealer) {
    console.log(`  "${d._id}": ${d.count}`);
  }

  // Customer vehicle analysis in FLWup leads
  console.log('\n--- VEHICLES IN FLWUP LEADS ---');
  const leadsWithVehicle = await flwupDb.collection('leads').countDocuments({
    $or: [
      { vehicle_make: { $exists: true, $ne: null, $ne: '' } },
      { vehicle_model: { $exists: true, $ne: null, $ne: '' } }
    ]
  });
  console.log(`Leads with vehicle info (make/model): ${leadsWithVehicle}`);

  // Test drive, trade in, loan car distribution
  console.log('\n--- LEADS FEATURES (test_drive, trade_in, loan_car) ---');
  const withTestDrive = await flwupDb.collection('leads').countDocuments({ 'test_drive.booked': true });
  const withTradeIn = await flwupDb.collection('leads').countDocuments({ trade_in: { $exists: true, $ne: null } });
  const withLoanCar = await flwupDb.collection('leads').countDocuments({ 'loan_car.required': true });
  console.log(`Test drive booked: ${withTestDrive}`);
  console.log(`Trade in present: ${withTradeIn}`);
  console.log(`Loan car required: ${withLoanCar}`);

  await gsClient.close();
  await flwupClient.close();
}

main().catch(console.error);
