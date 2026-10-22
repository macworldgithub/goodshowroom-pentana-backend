/**
 * Comprehensive seed script for Good Showroom
 * Seeds: customers, vehicles, sales leads, service appointments, repair orders,
 *        tasks, workshop resources, customer journal entries, delivery plans
 *
 * Run: node scripts/seed-all-data.mjs
 */
import fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { MongoClient } from "mongodb";

if (fs.existsSync(".env")) { process.loadEnvFile(".env"); }

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DATABASE = process.env.MONGODB_DATABASE;
if (!MONGODB_URI || !MONGODB_DATABASE) throw new Error("MONGODB_URI and MONGODB_DATABASE must be set");

function uuid() { return randomUUID(); }
function nowStr() { return new Date().toISOString(); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); }
function daysFromNow(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString(); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) { return [...arr].sort(() => Math.random() - 0.5).slice(0, n); }
function hashObj(obj) { return createHash("sha256").update(JSON.stringify(obj)).digest("hex"); }

const FIRST_NAMES = ["James","Oliver","William","Jack","Noah","Lucas","Henry","Ethan","Alexander","Mason","Emma","Olivia","Ava","Charlotte","Mia","Sophia","Amelia","Isabella","Emily","Lily","Liam","Benjamin","Max","Leo","Tom","Sam","Chloe","Grace","Sophie","Jessica","Sarah","Rachel","Michael","David","Matthew","Daniel","Andrew","Ryan","Patrick","Kevin","Anthony","Mark","Paul","Aiden","Logan","Nathan","Aaron","Tyler","Connor","Dylan","Hannah","Zoe","Natalie","Victoria","Laura","Nicole","Melissa"];
const LAST_NAMES = ["Smith","Jones","Williams","Brown","Taylor","Davies","Wilson","Evans","Thomas","Roberts","Johnson","Walker","Wright","Thompson","White","Watson","Jackson","Harris","Martin","Clarke","Cooper","Murphy","Sullivan","McCarthy","Walsh","Ryan","Nguyen","Tran","Le","Pham","Singh","Sharma","Patel","Li","Chen","Zhang","Wang","Liu","Kim","Park","Lee","Choi","Rossi","Ferrari","Esposito","Bianchi","Romano","Anderson","Morrison","Campbell","Stewart","Mitchell","Robertson"];
const AU_PHONES = ["0412 345 678","0423 456 789","0434 567 890","0445 678 901","0456 789 012","0467 890 123","0478 901 234","0489 012 345","0411 222 333","0422 333 444","0433 444 555","0444 555 666","0455 666 777","0466 777 888","0477 888 999","0488 999 000","0413 111 222","0424 222 333","0435 333 444","0446 444 555"];

const OWNED_VEHICLES = [
  { make:"Kia", model:"Sportage", year:2022, rego:"1ABC234" },
  { make:"Hyundai", model:"Tucson", year:2021, rego:"2BCD345" },
  { make:"Kia", model:"Stinger", year:2020, rego:"3CDE456" },
  { make:"Hyundai", model:"i30", year:2023, rego:"4DEF567" },
  { make:"Mitsubishi", model:"Outlander", year:2022, rego:"5EFG678" },
  { make:"Kia", model:"Cerato", year:2019, rego:"6FGH789" },
  { make:"Hyundai", model:"Ioniq 5", year:2023, rego:"7GHI890" },
  { make:"MG", model:"ZS EV", year:2022, rego:"8HIJ901" },
  { make:"Toyota", model:"RAV4", year:2021, rego:"9IJK012" },
  { make:"Mazda", model:"CX-5", year:2022, rego:"1JKL123" },
  { make:"Kia", model:"Seltos", year:2023, rego:"2KLM234" },
  { make:"Hyundai", model:"Santa Fe", year:2020, rego:"3LMN345" },
  { make:"Mitsubishi", model:"ASX", year:2021, rego:"4MNO456" },
  { make:"Kia", model:"Carnival", year:2022, rego:"5NOP567" },
  { make:"Nissan", model:"Qashqai", year:2023, rego:"6OPQ678" },
  { make:"Ford", model:"Escape", year:2021, rego:"7PQR789" },
  { make:"Kia", model:"Sorento", year:2023, rego:"8QRS890" },
  { make:"Hyundai", model:"Kona", year:2022, rego:"9RST901" },
  { make:"Holden", model:"Commodore", year:2018, rego:"1STU012" },
  { make:"Volkswagen", model:"Golf", year:2020, rego:"2TUV123" },
];

const SERVICE_TYPES = ["15,000 km Service","30,000 km Service","45,000 km Service","60,000 km Service","Brake Inspection","Tyre Rotation","Air Conditioning Service","Logbook Service","Major Service","Pre-Purchase Inspection","Safety Check","Warranty Repair","Complimentary Inspection","Roadworthy Certificate"];
const LEAD_SOURCES = ["Walk-in","Website Enquiry","Phone Enquiry","Referral","AutoTrader","carsales.com.au","Facebook Ad","Google Ad","Trade-in Enquiry","Service Customer","Return Customer"];
const VEHICLE_INTERESTS = ["Kia Sportage GT-Line AWD","Hyundai Tucson Elite AWD","Kia EV6 GT","Hyundai Ioniq 6 Elite","Mitsubishi Outlander ES","Kia Carnival GT-Line","MG ZS EV Excite+","Kia Sorento GT-Line","Hyundai Santa Fe Elite","Kia Stinger GT","Nissan LEAF Plus","Kia Tasman X-Line","Chery Omoda 5","BYD Atto 3","MG4 Excite 64","Kia Seltos GT-Line","Hyundai i30 N","Geely EX5 Ultra","GAC GS8 Ultra"];
const RO_OPERATIONS = ["Engine oil and filter change","Tyre rotation and balance","Brake pad replacement","Air filter replacement","Cabin filter replacement","Spark plug replacement","Coolant flush","Transmission fluid service","Battery replacement","Wiper blade replacement","Wheel alignment","AC regas and service","Diagnostic scan","Safety recall campaign"];
const PIPELINE_STAGES = ["new","contacted","qualified","test_drive","negotiation","won","lost"];
const RO_STATUSES = ["booked","arrived","in_progress","waiting_parts","ready","invoiced"];
const PILOT_PREFIXES = ["01","20","40","50","51","52","70","90"];
const ADVISOR_NAMES = ["Emma Rodriguez","Liam Chen","Sophie Walsh"];

async function seedAllData() {
  console.log("Connecting to MongoDB...");
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DATABASE);
  console.log("Connected to:", MONGODB_DATABASE);

  const org = await db.collection("organisations").findOne({});
  if (!org) throw new Error("No organisation found. Run setup first.");
  const orgId = org.id;
  console.log("Organisation:", org.name);

  const sites = await db.collection("sites").find({ organisation_id: orgId }).toArray();
  const pilotSites = sites.filter(s => { const m = s.name.match(/^(\d+)\|/); return m && PILOT_PREFIXES.includes(m[1]); });
  console.log("Pilot sites:", pilotSites.map(s => s.name).join(", "));

  const brands = await db.collection("brands").find({ organisation_id: orgId }).toArray();
  const memberships = await db.collection("memberships").find({ organisation_id: orgId }).toArray();
  let adminUserId = memberships.find(m => m.role === "ADMIN")?.user_id || memberships[0]?.user_id || uuid();
  const userIds = [...new Set(memberships.map(m => m.user_id))];
  if (userIds.length === 0) userIds.push(adminUserId);
  console.log("Admin user:", adminUserId);

  const stockVehicles = await db.collection("stock_vehicles").find({ organisation_id: orgId, status: "available" }).toArray();
  const stockBySite = new Map();
  for (const v of stockVehicles) {
    if (!stockBySite.has(v.site_id)) stockBySite.set(v.site_id, []);
    stockBySite.get(v.site_id).push(v);
  }
  console.log("Available stock vehicles:", stockVehicles.length);

  const ts = nowStr();

  // 1. WORKSHOP RESOURCES
  console.log("\n--- Workshop Resources ---");
  const existingWR = await db.collection("workshop_resources").countDocuments({ organisation_id: orgId });
  if (existingWR === 0) {
    const wrs = [];
    for (const site of pilotSites) {
      for (let i = 0; i < ADVISOR_NAMES.length; i++) {
        const id = uuid();
        wrs.push({ _id: id, id, organisation_id: orgId, site_id: site.id,
          name: ADVISOR_NAMES[i] + " (Bay " + (i+1) + ")", active: true,
          days: [1,2,3,4,5], open_minute: 480, close_minute: 1020,
          version: 0, booking_revision: 0, created_by: adminUserId,
          create_key: "seed-wr-" + site.id + "-" + i,
          create_hash: hashObj({ siteId: site.id, idx: i }),
          created_at: ts, updated_at: ts });
      }
    }
    await db.collection("workshop_resources").insertMany(wrs);
    console.log("Inserted", wrs.length, "workshop resources");
  } else { console.log("Skipping - already exists:", existingWR); }

  // 2. CUSTOMERS
  console.log("\n--- Customers ---");
  const existingCustCount = await db.collection("customers").countDocuments({ organisation_id: orgId });
  const allCustomers = [];
  if (existingCustCount < 50) {
    for (const site of pilotSites) {
      for (let i = 0; i < 50; i++) {
        const fn = pick(FIRST_NAMES); const ln = pick(LAST_NAMES);
        const email = fn.toLowerCase() + "." + ln.toLowerCase() + Math.floor(Math.random()*99) + "@" + pick(["gmail.com","hotmail.com","outlook.com","yahoo.com.au","bigpond.com"]);
        const custId = uuid();
        allCustomers.push({ _id: custId, id: custId, organisation_id: orgId, site_id: site.id,
          created_by: adminUserId, assigned_to: pick(userIds),
          first_name: fn, last_name: ln, email, phone: pick(AU_PHONES),
          source: "simulated", external_ids: { simulated: "SIM-" + custId.slice(0,8).toUpperCase() },
          integration_mode: "simulated",
          privacy: { do_not_contact: false, email: pick(["granted","granted","granted","denied"]), sms: pick(["granted","granted","unknown"]), call: pick(["granted","granted","unknown"]) },
          created_at: daysAgo(Math.floor(Math.random()*180)),
          updated_at: daysAgo(Math.floor(Math.random()*30)) });
      }
    }
    await db.collection("customers").insertMany(allCustomers);
    console.log("Inserted", allCustomers.length, "customers");
  } else {
    console.log("Loading existing customers:", existingCustCount);
    const existing = await db.collection("customers").find({ organisation_id: orgId }).toArray();
    allCustomers.push(...existing);
  }

  const customersBySite = new Map();
  for (const c of allCustomers) {
    if (!customersBySite.has(c.site_id)) customersBySite.set(c.site_id, []);
    customersBySite.get(c.site_id).push(c);
  }

  // 3. CUSTOMER VEHICLES
  console.log("\n--- Customer Vehicles ---");
  const existingCV = await db.collection("customer_vehicles").countDocuments({ organisation_id: orgId });
  if (existingCV === 0) {
    const cvs = [];
    for (const cust of allCustomers.filter(() => Math.random() < 0.6)) {
      const v = pick(OWNED_VEHICLES); const cvId = uuid();
      cvs.push({ _id: cvId, id: cvId, organisation_id: orgId, site_id: cust.site_id, customer_id: cust.id,
        make: v.make, model: v.model, year: v.year, registration: v.rego,
        vin: "WBA" + Math.random().toString(36).slice(2,14).toUpperCase(),
        odometer_km: Math.floor(20000 + Math.random()*120000),
        next_service_date: daysFromNow(Math.floor(Math.random()*120 - 30)),
        created_by: adminUserId, source: "simulated", integration_mode: "simulated",
        created_at: cust.created_at, updated_at: cust.updated_at });
    }
    if (cvs.length > 0) { await db.collection("customer_vehicles").insertMany(cvs); }
    console.log("Inserted", cvs.length, "customer vehicles");
  } else { console.log("Skipping - already exists:", existingCV); }

  // 4. SALES LEADS
  console.log("\n--- Sales Leads ---");
  const existingLeads = await db.collection("sales_leads").countDocuments({ organisation_id: orgId });
  const allLeads = [];
  if (existingLeads < 20) {
    for (const site of pilotSites) {
      const siteCusts = customersBySite.get(site.id) || [];
      const siteStock = stockBySite.get(site.id) || [];
      const n = Math.min(30, siteCusts.length);
      for (let i = 0; i < n; i++) {
        const cust = siteCusts[i]; const stage = pick(PIPELINE_STAGES);
        const vehicleInterest = pick(VEHICLE_INTERESTS); const leadId = uuid();
        let stockIds = [];
        if (["negotiation","won","test_drive"].includes(stage) && siteStock.length > 0) {
          stockIds = [pick(siteStock).id];
        }
        const status = ["won","lost"].includes(stage) ? "closed" : ["test_drive","negotiation"].includes(stage) ? "qualified" : stage === "new" ? "new" : "contacted";
        const lead = { _id: leadId, id: leadId, organisation_id: orgId, site_id: site.id,
          customer_id: cust.id, assigned_to: pick(userIds), created_by: adminUserId,
          title: cust.first_name + " " + cust.last_name + " - " + vehicleInterest,
          source: pick(LEAD_SOURCES), vehicle_interest: vehicleInterest, status,
          pipeline_stage: stage, stock_ids: stockIds, version: 0,
          integration_mode: "simulated",
          create_key: "seed-lead-" + leadId,
          create_hash: hashObj({ siteId: site.id, custId: cust.id, vehicleInterest }),
          created_at: daysAgo(Math.floor(Math.random()*60)),
          updated_at: daysAgo(Math.floor(Math.random()*7)) };
        allLeads.push(lead);
      }
    }
    await db.collection("sales_leads").insertMany(allLeads);
    console.log("Inserted", allLeads.length, "sales leads");
  } else {
    console.log("Loading existing leads:", existingLeads);
    const existing = await db.collection("sales_leads").find({ organisation_id: orgId }).toArray();
    allLeads.push(...existing);
  }

  // 5. TRADE-IN APPRAISALS
  console.log("\n--- Trade-in Appraisals ---");
  const existingTA = await db.collection("trade_in_appraisals").countDocuments({ organisation_id: orgId });
  if (existingTA === 0) {
    const appraisals = [];
    for (const lead of allLeads.filter(l => ["negotiation","won","test_drive"].includes(l.pipeline_stage) && Math.random() > 0.4)) {
      const v = pick(OWNED_VEHICLES); const val = Math.floor(8000 + Math.random()*35000);
      const status = pick(["draft","valued","valued","valued"]); const apId = uuid();
      appraisals.push({ _id: apId, id: apId, organisation_id: orgId, site_id: lead.site_id,
        lead_id: lead.id, customer_id: lead.customer_id, created_by: adminUserId,
        make: v.make, model: v.model, year: v.year,
        odometer_km: Math.floor(30000 + Math.random()*120000), registration: v.rego, vin: null,
        condition_notes: pick(["Good overall condition, minor wear on driver seat","Well maintained, recent service history present","Excellent condition, low km, full service history","Average condition, needs new tyres soon"]),
        valuation_notes: status === "valued" ? "Market value assessed at $" + val.toLocaleString() : null,
        valuation_cents: status === "valued" ? val * 100 : null,
        currency: "AUD", status, withdrawal_reason: null,
        source: "local", integration_mode: "simulated", version: 0,
        create_key: "seed-ap-" + apId, create_hash: hashObj({ leadId: lead.id }),
        created_at: daysAgo(Math.floor(Math.random()*30)), updated_at: daysAgo(Math.floor(Math.random()*7)) });
    }
    if (appraisals.length > 0) { await db.collection("trade_in_appraisals").insertMany(appraisals); }
    console.log("Inserted", appraisals.length, "appraisals");
  } else { console.log("Skipping - already exists:", existingTA); }

  // 6. SALES DEALS
  console.log("\n--- Sales Deals ---");
  const existingDeals = await db.collection("sales_deals").countDocuments({ organisation_id: orgId });
  if (existingDeals === 0) {
    const deals = [];
    for (const lead of allLeads.filter(l => ["negotiation","won"].includes(l.pipeline_stage) && l.stock_ids && l.stock_ids.length > 0)) {
      const stockId = lead.stock_ids[0];
      const sv = stockVehicles.find(s => s.id === stockId);
      if (!sv) continue;
      const salePrice = sv.price_cents || Math.floor(30000 + Math.random()*40000) * 100;
      const discount = Math.floor(Math.random()*3000) * 100;
      const fees = Math.floor(500 + Math.random()*1500) * 100;
      const tradeIn = Math.random() > 0.5 ? Math.floor(8000 + Math.random()*25000) * 100 : 0;
      const total = salePrice - discount + fees - tradeIn;
      const dealStatus = lead.pipeline_stage === "won" ? pick(["approved","submitted"]) : "draft";
      const dealId = uuid();
      deals.push({ _id: dealId, id: dealId, organisation_id: orgId, site_id: lead.site_id,
        lead_id: lead.id, customer_id: lead.customer_id, stock_id: stockId, brand_id: sv.brand_id,
        stock_label: sv.make + " " + sv.model + " " + sv.year, stock_version: sv.version || 0,
        appraisal_id: null, appraisal_version: null,
        sale_price_cents: salePrice, discount_cents: discount, fees_cents: fees,
        trade_in_cents: tradeIn, total_cents: total, currency: "AUD", status: dealStatus,
        notes: pick(["Customer happy with final price. Finance pre-approved.","Pending manager approval.","Trade-in valued. Customer agreed to terms.",""]),
        reviewed_by: dealStatus === "approved" ? pick(userIds) : null,
        reviewed_at: dealStatus === "approved" ? daysAgo(2) : null,
        review_note: dealStatus === "approved" ? "Approved per standard terms" : null,
        created_by: adminUserId, version: 0, source: "local", integration_mode: "simulated",
        create_key: "seed-deal-" + dealId, create_hash: hashObj({ leadId: lead.id, stockId }),
        created_at: daysAgo(Math.floor(Math.random()*20)), updated_at: daysAgo(Math.floor(Math.random()*5)) });
    }
    if (deals.length > 0) { await db.collection("sales_deals").insertMany(deals); }
    console.log("Inserted", deals.length, "sales deals");
  } else { console.log("Skipping - already exists:", existingDeals); }

  // 7. SERVICE APPOINTMENTS
  console.log("\n--- Service Appointments ---");
  const existingAppts = await db.collection("service_appointments").countDocuments({ organisation_id: orgId });
  if (existingAppts < 10) {
    const appts = [];
    const wrInDb = await db.collection("workshop_resources").find({ organisation_id: orgId }).toArray();
    for (const site of pilotSites) {
      const siteCusts = customersBySite.get(site.id) || [];
      const siteWrs = wrInDb.filter(r => r.site_id === site.id);
      const siteBrandId = site.brand_ids?.[0] || brands[0]?.id;
      for (let day = -1; day <= 6; day++) {
        const numAppts = day === 0 ? 5 : 3;
        for (let j = 0; j < numAppts; j++) {
          const cust = pick(siteCusts); if (!cust) continue;
          const resource = pick(siteWrs);
          const ownedVeh = pick(OWNED_VEHICLES);
          const startDate = new Date(); startDate.setDate(startDate.getDate() + day); startDate.setHours(8 + j, 0, 0, 0);
          const endDate = new Date(startDate.getTime() + 90 * 60000);
          let status = day < 0 ? pick(["collected","invoiced","ready"]) : day === 0 ? pick(["confirmed","arrived","in_progress","ready"]) : pick(["booked","confirmed"]);
          const apId = uuid();
          appts.push({ _id: apId, id: apId, organisation_id: orgId, site_id: site.id,
            brand_id: siteBrandId, customer_id: cust.id,
            assigned_to: resource?.id || pick(userIds), created_by: adminUserId,
            resource_id: resource?.id || null,
            title: pick(SERVICE_TYPES) + " - " + ownedVeh.make + " " + ownedVeh.model,
            vehicle: ownedVeh.year + " " + ownedVeh.make + " " + ownedVeh.model + " (" + ownedVeh.rego + ")",
            starts_at: startDate.toISOString(), ends_at: endDate.toISOString(),
            notes: pick(["Customer requested early drop-off","Customer waiting","Loan car arranged","First service after delivery",""]),
            outcome_note: ["collected","invoiced"].includes(status) ? "Service completed." : null,
            status, version: 0, integration_mode: "simulated",
            create_key: "seed-appt-" + apId, create_hash: hashObj({ siteId: site.id, custId: cust.id, day, j }),
            created_at: daysAgo(Math.floor(Math.random()*30)), updated_at: startDate.toISOString() });
        }
      }
    }
    await db.collection("service_appointments").insertMany(appts);
    console.log("Inserted", appts.length, "service appointments");
  } else { console.log("Skipping - already exists:", existingAppts); }

  // 8. REPAIR ORDERS
  console.log("\n--- Repair Orders ---");
  await db.collection("repair_orders").deleteMany({ organisation_id: orgId });
  const ros = [];
  const roStatusList = ["waiting_authority", "in_workshop", "waiting_parts", "ready", "waiting_authority", "in_workshop"];
  for (const site of pilotSites) {
    const siteCusts = customersBySite.get(site.id) || [];
    const siteBrandId = site.brand_ids?.[0] || brands[0]?.id;
    for (let i = 0; i < 8; i++) {
      const cust = pick(siteCusts); if (!cust) continue;
      const ownedVeh = pick(OWNED_VEHICLES);
      const status = roStatusList[i % roStatusList.length];
      const ops = pickN(RO_OPERATIONS, 1 + Math.floor(Math.random()*3));
      const roId = uuid();
      const openedAt = daysAgo(Math.floor(Math.random()*5));
      const roNum = String(100000 + Math.floor(Math.random()*900000));
      const vehicleDesc = `${ownedVeh.year} ${ownedVeh.make} ${ownedVeh.model} (${ownedVeh.rego})`;
      const opsSummary = ops.join(", ");
      ros.push({
        _id: roId,
        id: roId,
        organisation_id: orgId,
        site_id: site.id,
        brand_id: siteBrandId,
        customer_id: cust.id,
        appointment_id: roId,
        assigned_to: pick(userIds),
        vehicle: vehicleDesc,
        vehicle_external_id: null,
        number: roNum,
        external_id: `SIM-RO-${site.id.slice(0, 4)}-${roNum}`,
        integration_mode: "simulated",
        source_status: status === "ready" ? "WIP Completed" : status === "waiting_authority" ? "Estimate Awaiting Auth" : "In Progress",
        status,
        operations_summary: opsSummary,
        promised_at: daysFromNow(Math.floor(Math.random()*3)),
        updated_at: daysAgo(Math.floor(Math.random()*2)),
        created_at: openedAt,
        version: 0,
        authority_notes: status === "waiting_authority" ? [{ text: "Customer phone query on brake fluid replacement", recorded_at: openedAt, recorded_by: adminUserId }] : [],
        status_history: [{ from: "waiting_authority", to: status, note: "Initial check-in", recorded_at: openedAt, recorded_by: adminUserId }],
        ready_at: status === "ready" ? nowStr() : null,
        invoiced_at: null,
        collection: null,
        created_by: adminUserId
      });
    }
  }
  if (ros.length > 0) {
    await db.collection("repair_orders").insertMany(ros, { ordered: false });
    console.log("Inserted", ros.length, "repair orders");
  }

  // 9. TASKS
  console.log("\n--- Tasks ---");
  const existingTasks = await db.collection("tasks").countDocuments({ organisation_id: orgId });
  if (existingTasks < 20) {
    const tasks = [];
    const taskTitles = [
      { title: "Call customer re: test drive follow-up", kind: "call" },
      { title: "Send quote to customer", kind: "follow_up" },
      { title: "Book delivery appointment", kind: "follow_up" },
      { title: "Follow up on finance application", kind: "follow_up" },
      { title: "Confirm service appointment tomorrow", kind: "call" },
      { title: "CSI survey follow-up call", kind: "call" },
      { title: "Chase trade-in valuation approval", kind: "follow_up" },
      { title: "Send vehicle photos to customer", kind: "follow_up" },
      { title: "Follow up missed call", kind: "call" },
      { title: "Deliver PDI checklist to service", kind: "follow_up" },
    ];
    for (const site of pilotSites) {
      const siteCusts = customersBySite.get(site.id) || [];
      for (let i = 0; i < 15; i++) {
        const cust = pick(siteCusts); if (!cust) continue;
        const tmpl = pick(taskTitles);
        const dueOffset = Math.floor(-2 + Math.random()*10);
        const isCompleted = dueOffset < 0 && Math.random() > 0.3;
        const taskId = uuid();
        tasks.push({ _id: taskId, id: taskId, organisation_id: orgId, site_id: site.id,
          customer_id: cust.id, created_by: adminUserId, assigned_to: pick(userIds),
          title: tmpl.title, kind: tmpl.kind,
          details: Math.random() > 0.5 ? "Customer enquired about " + pick(VEHICLE_INTERESTS) : null,
          due_at: daysFromNow(dueOffset), priority: pick(["low","normal","normal","high"]),
          completed_at: isCompleted ? daysAgo(Math.abs(dueOffset)) : null,
          version: 0, integration_mode: "simulated",
          created_at: daysAgo(Math.floor(2 + Math.random()*14)),
          updated_at: daysAgo(Math.floor(Math.random()*3)) });
      }
    }
    await db.collection("tasks").insertMany(tasks);
    console.log("Inserted", tasks.length, "tasks");
  } else { console.log("Skipping - already exists:", existingTasks); }

  // 10. CUSTOMER JOURNAL
  console.log("\n--- Customer Journal ---");
  const existingJournals = await db.collection("customer_journal").countDocuments({ organisation_id: orgId });
  if (existingJournals < 20) {
    const journals = [];
    const noteTexts = [
      "Customer called to confirm delivery time for tomorrow.",
      "Left voicemail, will follow up again Thursday.",
      "Customer interested in the GT-Line variant, wants to compare pricing.",
      "Test drive completed. Customer very positive about the EV range.",
      "Discussed trade-in options. Customer wants to think overnight.",
      "Customer confirmed they will finance through Macquarie.",
      "Warranty repair authorised. Parts on order ETA 3 days.",
      "Service completed. Customer happy with work done.",
      "Customer mentioned neighbour purchased same model - referral opportunity.",
      "Follow up after CSI survey - customer rated 9/10, mentioned quick service.",
    ];
    for (const cust of allCustomers.slice(0, 80)) {
      const numEntries = 1 + Math.floor(Math.random()*4);
      for (let i = 0; i < numEntries; i++) {
        const jId = uuid(); const kind = Math.random() > 0.4 ? "call" : "note";
        const entry = { _id: jId, id: jId, organisation_id: orgId, site_id: cust.site_id,
          customer_id: cust.id, created_by: pick(userIds), kind, text: pick(noteTexts),
          occurred_at: daysAgo(Math.floor(Math.random()*30)),
          integration_mode: "simulated",
          idempotency_key: "seed-journal-" + jId, request_hash: hashObj({ custId: cust.id, idx: i }),
          created_at: daysAgo(Math.floor(Math.random()*30)) };
        if (kind === "call") {
          entry.direction = pick(["incoming","outgoing"]);
          entry.outcome = pick(["connected","connected","no_answer","voicemail"]);
        }
        journals.push(entry);
      }
    }
    await db.collection("customer_journal").insertMany(journals);
    console.log("Inserted", journals.length, "journal entries");
  } else { console.log("Skipping - already exists:", existingJournals); }

  // 11. DELIVERY PLANS & STOCK RESERVATIONS
  console.log("\n--- Delivery Plans & Reservations ---");
  const existingDP = await db.collection("delivery_plans").countDocuments({ organisation_id: orgId });
  if (existingDP === 0) {
    const candidateDeals = await db.collection("sales_deals").find({ organisation_id: orgId, status: { "$in": ["approved","submitted","won"] } }).toArray();
    const deliveries = [];
    const reservations = [];
    const deliveryItems = ["documents", "payment_verified", "vehicle_preparation", "customer_confirmation", "handover_pack"];
    const checkNotes = {
      documents: { done: "Contract, registration transfer and RWC verified", pending: "Awaiting signed transfer paperwork" },
      payment_verified: { done: "EFT settlement receipt confirmed by accounts", pending: "Finance payout letter pending approval" },
      vehicle_preparation: { done: "PDI complete, tint & mats fitted, final detail done", pending: "Detail and accessory check in progress" },
      customer_confirmation: { done: "Customer confirmed collection slot with advisor", pending: "SMS sent to customer to confirm arrival time" },
      handover_pack: { done: "Spare keys, manuals, roadside assist pack in glovebox", pending: "Awaiting duplicate key coding" }
    };

    let idxCount = 0;
    for (const deal of candidateDeals) {
      const stock = await db.collection("stock_vehicles").findOne({ id: deal.stock_id });
      if (!stock) continue;

      const dealVersion = deal.version || 0;
      const stockVersion = stock.version || 0;
      await db.collection("sales_deals").updateOne({ _id: deal._id }, { $set: { status: "approved", stock_version: stockVersion, version: dealVersion } });

      const scheduledDays = 1 + (idxCount % 10);
      const scheduledAt = daysFromNow(scheduledDays);
      const resExpiry = daysFromNow(scheduledDays + 3);

      const resId = uuid();
      reservations.push({
        _id: resId, id: resId, organisation_id: orgId, site_id: deal.site_id, lead_id: deal.lead_id, customer_id: deal.customer_id,
        deal_id: deal.id, stock_id: deal.stock_id, brand_id: deal.brand_id, status: "active", expires_at: resExpiry, ended_at: null,
        reason: `Reserved for scheduled delivery (${stock.make} ${stock.model})`, created_by: adminUserId, version: 0,
        create_key: `seed-res-${resId}`, create_hash: hashObj({ dealId: deal.id, stockId: deal.stock_id }),
        created_at: daysAgo(2), updated_at: daysAgo(1), ...(deal.integration_mode ? { integration_mode: deal.integration_mode } : {})
      });

      const checklist = {};
      const numDone = idxCount % 3 === 0 ? 5 : idxCount % 3 === 1 ? 4 : 3;
      deliveryItems.forEach((key, kIdx) => {
        const isDone = kIdx < numDone;
        checklist[key] = {
          complete: isDone,
          note: isDone ? checkNotes[key].done : checkNotes[key].pending,
          updated_by: isDone ? adminUserId : null,
          updated_at: isDone ? daysAgo(1) : null
        };
      });

      const dpId = uuid();
      deliveries.push({
        _id: dpId, id: dpId, organisation_id: orgId, site_id: deal.site_id, lead_id: deal.lead_id, customer_id: deal.customer_id,
        deal_id: deal.id, deal_version: dealVersion, stock_id: deal.stock_id,
        stock_label: `${stock.make} ${stock.model} (${stock.year}) · #${stock.stock_number || 'STK'}`,
        brand_id: deal.brand_id, scheduled_at: scheduledAt,
        notes: `Handover scheduled. Customer confirmed morning collection slot.`, status: "planned", checklist,
        created_by: adminUserId, version: 0, integration_mode: "simulated",
        create_key: "seed-dp-" + dpId, create_hash: hashObj({ dealId: deal.id }),
        created_at: daysAgo(Math.floor(Math.random()*5)), updated_at: daysAgo(1)
      });
      idxCount++;
    }

    if (reservations.length > 0) await db.collection("stock_reservations").insertMany(reservations);
    if (deliveries.length > 0) await db.collection("delivery_plans").insertMany(deliveries);
    console.log("Inserted", deliveries.length, "delivery plans and", reservations.length, "reservations");
  } else { console.log("Skipping - already exists:", existingDP); }

  // 12. LOAN CARS
  console.log("\n--- Loan Cars ---");
  const existingLC = await db.collection("loan_cars").countDocuments({ organisation_id: orgId });
  if (existingLC === 0) {
    const lcModels = [{ make:"Kia", model:"Picanto", year:2023 },{ make:"Hyundai", model:"i20", year:2022 }];
    const lcs = [];
    for (const site of pilotSites.slice(0,4)) {
      for (let i = 0; i < lcModels.length; i++) {
        const m = lcModels[i]; const lcId = uuid();
        lcs.push({ _id: lcId, id: lcId, organisation_id: orgId, site_id: site.id,
          make: m.make, model: m.model, year: m.year,
          registration: site.name.split("|")[0].trim() + "-LC0" + (i+1),
          status: pick(["available","available","in_use"]),
          created_by: adminUserId, created_at: ts, updated_at: ts });
      }
    }
    if (lcs.length > 0) { await db.collection("loan_cars").insertMany(lcs); }
    console.log("Inserted", lcs.length, "loan cars");
  } else { console.log("Skipping - already exists:", existingLC); }

  // SUMMARY
  console.log("\n=== FINAL COUNTS ===");
  const cols = ["customers","customer_vehicles","sales_leads","trade_in_appraisals","sales_deals","service_appointments","repair_orders","tasks","customer_journal","delivery_plans","loan_cars","workshop_resources","stock_vehicles","brands","sites"];
  for (const col of cols) {
    const c = await db.collection(col).countDocuments();
    console.log(col.padEnd(28) + String(c).padStart(6));
  }

  await client.close();
  console.log("\nAll data seeded successfully!");
}

seedAllData().catch(err => { console.error("Seeding failed:", err); process.exit(1); });
