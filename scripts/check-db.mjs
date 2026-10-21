import { MongoClient } from 'mongodb';

if (process.existsSync?.('.env') || true) {
  try { process.loadEnvFile('.env'); } catch {}
}

const client = new MongoClient(process.env.MONGODB_URI || 'mongodb+srv://abdulahadnauman10_db_user:Neximet123@cluster0.qeczbwo.mongodb.net/');
await client.connect();
const db = client.db(process.env.MONGODB_DATABASE || 'goodshowroom-pentana');

const sites = await db.collection('sites').find({}).toArray();
console.log('=== SITES ===');
for (const s of sites) {
  console.log(` - "${s.name}" (id: ${s.id}) | brand_ids: ${s.brand_ids?.length ?? 'none'}`);
}

const stockCount = await db.collection('stock_vehicles').countDocuments();
console.log('\n=== STOCK VEHICLES ===');
console.log('Total:', stockCount);

const bySite = await db.collection('stock_vehicles').aggregate([
  { $group: { _id: '$site_id', count: { $sum: 1 } } }
]).toArray();
console.log('By site_id:');
for (const s of bySite) {
  const site = sites.find(x => x.id === s._id);
  console.log(` - ${site?.name ?? s._id}: ${s.count}`);
}

const sample = await db.collection('stock_vehicles').findOne({});
console.log('\nSample vehicle:');
console.log(JSON.stringify(sample, null, 2));

const brands = await db.collection('brands').find({}).toArray();
console.log('\n=== BRANDS ===');
console.log('Total:', brands.length);
for (const b of brands) console.log(` - "${b.name}" (id: ${b.id})`);

await client.close();
