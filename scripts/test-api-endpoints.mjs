import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Generate a link or sign in as sales@morang.com or admin
const { data: suData } = await supabase.auth.admin.listUsers();
const adminUser = suData.users.find(u => u.email === "abdulahadnauman10@gmail.com") || suData.users[0];

console.log("Testing with user:", adminUser.email, adminUser.id);

// Generate a magic link or token
const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
  type: "magiclink",
  email: adminUser.email,
});

if (linkErr) {
  console.error("Magic link error:", linkErr);
  process.exit(1);
}

// Exchange token via Supabase client to get access_token
const anonClient = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const { data: sessionData, error: sessionErr } = await anonClient.auth.verifyOtp({
  token_hash: linkData.properties.hashed_token,
  type: "magiclink",
});

if (sessionErr) {
  console.error("verifyOtp error:", sessionErr);
  process.exit(1);
}

const token = sessionData.session.access_token;
console.log("Got Supabase access_token successfully!");

// Now test backend endpoints
const BACKEND = "http://localhost:4000/api";

async function get(path) {
  const res = await fetch(`${BACKEND}/${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, text };
  }
}

// 1. GET context / auth/me
const me = await get("auth/me");
console.log("\n--- auth/me ---");
console.log("Status:", me.status);
console.log("User:", me.data.user?.email);
console.log("Sites returned:", me.data.sites?.length);
const pilotSite = me.data.sites?.find(s => s.name.startsWith("01|")) || me.data.sites?.[0];
console.log("Using site:", pilotSite?.name, pilotSite?.id);

if (pilotSite) {
  const siteId = pilotSite.id;

  // 2. Customers
  const custs = await get(`customers?siteId=${siteId}&limit=5`);
  console.log("\n--- Customers ---");
  console.log("Status:", custs.status, "Count:", custs.data.customers?.length, "Pagination:", custs.data.pagination);
  if (custs.data.customers?.length > 0) {
    console.log("Sample customer:", custs.data.customers[0].first_name, custs.data.customers[0].last_name, custs.data.customers[0].phone);
  }

  // 3. Stock
  const stock = await get(`sales/stock?siteId=${siteId}&limit=5`);
  console.log("\n--- Stock ---");
  console.log("Status:", stock.status, "Count:", stock.data.vehicles?.length, "Pagination:", stock.data.pagination);
  if (stock.data.vehicles?.length > 0) {
    console.log("Sample vehicle:", stock.data.vehicles[0].stock_number, stock.data.vehicles[0].make, stock.data.vehicles[0].model, stock.data.vehicles[0].year);
  }

  // 4. Sales Leads / Enquiries
  const leads = await get(`sales/leads?siteId=${siteId}&limit=5`);
  console.log("\n--- Sales Leads ---");
  console.log("Status:", leads.status, "Count:", leads.data.leads?.length, "Pagination:", leads.data.pagination);
  if (leads.data.leads?.length > 0) {
    console.log("Sample lead:", leads.data.leads[0].title, "Stage:", leads.data.leads[0].pipeline_stage);
  }

  // 5. Sales Pipeline
  const pipeline = await get(`sales/pipeline?siteId=${siteId}&limit=5`);
  console.log("\n--- Sales Pipeline ---");
  console.log("Status:", pipeline.status, "Stages:", pipeline.data.stages);

  // 6. Deliveries
  const deliveries = await get(`sales/deliveries?siteId=${siteId}&limit=5`);
  console.log("\n--- Deliveries ---");
  console.log("Status:", deliveries.status, "Count:", deliveries.data.deliveries?.length);

  // 7. Service Appointments
  const service = await get(`service/appointments?siteId=${siteId}&limit=5`);
  console.log("\n--- Service Appointments ---");
  console.log("Status:", service.status, "Count:", service.data.appointments?.length);

  // 8. Service Diary
  const diary = await get(`service/diary?siteId=${siteId}&view=team&limit=5`);
  console.log("\n--- Service Diary (view=team) ---");
  console.log("Status:", diary.status, "Totals:", diary.data.totals, "Appointments in diary:", diary.data.appointments?.length);

  // 9. My Day
  const myDay = await get(`my-day?siteId=${siteId}&view=team&limit=5`);
  console.log("\n--- My Day (view=team) ---");
  console.log("Status:", myDay.status, "Totals:", myDay.data.totals, "Tasks:", myDay.data.items?.length);
}
