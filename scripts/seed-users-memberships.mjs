import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { createClient } from "@supabase/supabase-js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DATABASE = process.env.MONGODB_DATABASE;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DATABASE);

const org = await db.collection("organisations").findOne({});
if (!org) throw new Error("No organisation found");
const orgId = org.id;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const { data: suData } = await supabase.auth.admin.listUsers();
const supabaseUsers = suData?.users || [];

console.log("Supabase users count:", supabaseUsers.length);

const now = new Date().toISOString();

// Upsert all Supabase users into MongoDB users collection
for (const su of supabaseUsers) {
  await db.collection("users").updateOne(
    { _id: su.id },
    {
      $set: {
        email: su.email,
        full_name: su.user_metadata?.full_name || su.email?.split("@")[0].toUpperCase() + " staff",
        updated_at: now,
      },
    },
    { upsert: true }
  );
}

const sites = await db.collection("sites").find({ organisation_id: orgId }).toArray();
const PILOT_PREFIXES = ["01", "20", "40", "50", "51", "52", "70", "90"];
const pilotSites = sites.filter(s => {
  const m = s.name.match(/^(\d+)\|/);
  return m && PILOT_PREFIXES.includes(m[1]);
});

console.log("Found", pilotSites.length, "pilot sites");

// Assign memberships
const EXTRA_PERMISSIONS_ALL = [
  "customers.view_team",
  "customers.assign",
  "tasks.view_team",
  "tasks.assign",
  "sales.view_team",
  "sales.assign_leads",
  "service.view_team",
  "service.assign_work",
];

for (const su of supabaseUsers) {
  const email = (su.email || "").toLowerCase();
  const isAdmin = email.includes("admin") || email.includes("abdulahad") || email.includes("neximet");
  const isSales = email.includes("sales");
  const isService = email.includes("service");

  if (isAdmin) {
    // Org-wide Admin grant
    const existing = await db.collection("memberships").findOne({
      organisation_id: orgId,
      user_id: su.id,
      site_id: null,
      role: "ADMIN",
    });
    if (!existing) {
      const id = randomUUID();
      await db.collection("memberships").insertOne({
        _id: id,
        id,
        organisation_id: orgId,
        site_id: null,
        user_id: su.id,
        role: "ADMIN",
        status: "active",
        extra_permissions: EXTRA_PERMISSIONS_ALL,
        created_at: now,
      });
      console.log(`Created ADMIN membership for ${email}`);
    } else {
      console.log(`ADMIN membership exists for ${email}`);
    }
  }

  // Also give Sales & Service users memberships to all pilot sites
  for (const site of pilotSites) {
    if (isSales || isAdmin) {
      const existing = await db.collection("memberships").findOne({
        organisation_id: orgId,
        user_id: su.id,
        site_id: site.id,
        role: "SALES",
      });
      if (!existing) {
        const id = randomUUID();
        await db.collection("memberships").insertOne({
          _id: id,
          id,
          organisation_id: orgId,
          site_id: site.id,
          user_id: su.id,
          role: "SALES",
          status: "active",
          extra_permissions: ["customers.view_team", "tasks.view_team", "sales.view_team"],
          brand_ids: null,
          created_at: now,
        });
      }
    }

    if (isService || isAdmin) {
      const existing = await db.collection("memberships").findOne({
        organisation_id: orgId,
        user_id: su.id,
        site_id: site.id,
        role: "SERVICE",
      });
      if (!existing) {
        const id = randomUUID();
        await db.collection("memberships").insertOne({
          _id: id,
          id,
          organisation_id: orgId,
          site_id: site.id,
          user_id: su.id,
          role: "SERVICE",
          status: "active",
          extra_permissions: ["customers.view_team", "tasks.view_team", "service.view_team"],
          brand_ids: null,
          created_at: now,
        });
      }
    }
  }
}

const finalCount = await db.collection("memberships").countDocuments({ organisation_id: orgId });
console.log(`Total active memberships in MongoDB: ${finalCount}`);

await client.close();
