import fs from 'node:fs';
import { MongoClient } from 'mongodb';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DATABASE);

const siteId = '6035611f-6e3c-476c-870f-8ac8b0e12cee';

const openDeals = await db.collection('sales_deals').countDocuments({ site_id: siteId, status: { $in: ['draft', 'submitted', 'approved'] } });
const sevenDaysAgo = new Date(Date.now() - 7*86400000).toISOString();
const ageingDeals = await db.collection('sales_deals').countDocuments({ site_id: siteId, status: { $in: ['draft', 'submitted', 'approved'] }, created_at: { $lt: sevenDaysAgo } });

const openRos = await db.collection('repair_orders').countDocuments({ site_id: siteId, status: { $in: ['booked', 'arrived', 'in_progress', 'waiting_parts'] } });
const awaitingAuth = await db.collection('repair_orders').countDocuments({ site_id: siteId, status: { $in: ['booked', 'waiting_parts'] } });

const newLeads = await db.collection('sales_leads').countDocuments({ site_id: siteId, pipeline_stage: 'new' });

const handovers = await db.collection('delivery_plans').find({ site_id: siteId, status: 'planned' }).toArray();
let handoverRisk = 0;
for (const h of handovers) {
  const isOverdue = h.scheduled_at < new Date().toISOString();
  const checks = Object.values(h.checklist || {});
  const incomplete = checks.some(c => !c.complete);
  if (isOverdue || incomplete) handoverRisk++;
}

console.log({
  siteId,
  openDeals,
  ageingDeals,
  openRos,
  awaitingAuth,
  newLeads,
  handoverRisk,
  totalDeliveries: handovers.length
});

const tasks = await db.collection('tasks').find({ site_id: siteId }).toArray();
console.log('Tasks count for site:', tasks.length);

await client.close();
