import fs from "node:fs";
import { MongoClient } from "mongodb";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DATABASE);

const counts = await db.collection("stock_vehicles").aggregate([
  { $group: { _id: "$status", count: { $sum: 1 } } }
]).toArray();
console.log("Stock statuses:", counts);

const sampleBySite = await db.collection("stock_vehicles").aggregate([
  { $group: { _id: { site_id: "$site_id", status: "$status" }, count: { $sum: 1 } } },
  { $limit: 15 }
]).toArray();
console.log("Sample by site & status:", sampleBySite);

await client.close();
