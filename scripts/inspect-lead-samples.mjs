import { MongoClient } from 'mongodb';

const FLWUP_URI = 'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/flwup_crm';

async function inspectLeadSamples() {
  const client = new MongoClient(FLWUP_URI);
  await client.connect();
  const db = client.db();

  // Find a sold lead, a following_up lead, and a lost lead
  const soldLead = await db.collection('leads').findOne({ status: 'sold', pentana_id: { $exists: true } });
  console.log('--- SAMPLE SOLD LEAD ---');
  console.log(JSON.stringify(soldLead, null, 2));

  const followLead = await db.collection('leads').findOne({ status: 'following_up' });
  console.log('--- SAMPLE FOLLOWING UP LEAD ---');
  console.log(JSON.stringify(followLead, null, 2));

  // Check trade_in structure
  const tradeInLead = await db.collection('leads').findOne({ trade_in: { $exists: true, $ne: null } });
  console.log('--- SAMPLE TRADE IN ---');
  console.log(JSON.stringify(tradeInLead?.trade_in, null, 2));

  // Check channels structure
  const sampleWithChannels = await db.collection('leads').findOne({ channels: { $exists: true, $not: { $size: 0 } } });
  console.log('--- SAMPLE CHANNELS ---');
  console.log(JSON.stringify(sampleWithChannels?.channels, null, 2));

  // Check ai_status, ai_schedule_preference
  const aiLeads = await db.collection('leads').find({
    $or: [
      { ai_status: { $exists: true, $ne: null } },
      { ai_schedule_preference: { $exists: true, $ne: null } }
    ]
  }).limit(3).toArray();
  console.log('--- SAMPLE AI STATUS / SCHEDULE PREFERENCE ---');
  for (const l of aiLeads) {
    console.log({
      id: l._id,
      ai_status: l.ai_status,
      ai_schedule_preference: l.ai_schedule_preference,
      ai_queued_messages: l.ai_queued_messages
    });
  }

  // Check all distinct values of channels across all leads
  const allChannels = await db.collection('leads').distinct('channels');
  console.log('--- DISTINCT CHANNELS ---', allChannels);

  // Check all distinct lost_reasons
  const lostReasons = await db.collection('leads').distinct('lost_reason');
  console.log('--- DISTINCT LOST REASONS ---', lostReasons);

  await client.close();
}

inspectLeadSamples().catch(console.error);
