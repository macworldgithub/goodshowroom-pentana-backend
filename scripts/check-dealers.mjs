import { MongoClient } from 'mongodb';
const FLWUP_URI = 'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/flwup_crm';
async function run() {
  const client = new MongoClient(FLWUP_URI);
  await client.connect();
  const db = client.db();
  const dealerStores = await db.collection('leads').aggregate([
    { $group: { _id: { dealer: '$dealership_name', store: '$store_code', code: '$dealer_code' }, count: { $sum: 1 } } }
  ]).toArray();
  console.log(dealerStores);
  await client.close();
}
run();
