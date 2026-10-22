/**
 * Seed realistic Handover Lane data (delivery plans and stock reservations)
 * using the real scraped vehicle inventory and real customer deals.
 *
 * Run: node scripts/seed-handover-lane.mjs
 */
import fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { MongoClient } from "mongodb";

if (fs.existsSync(".env")) {
  process.loadEnvFile(".env");
}

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DATABASE = process.env.MONGODB_DATABASE;
if (!MONGODB_URI || !MONGODB_DATABASE) throw new Error("Missing MONGODB env vars");

function uuid() { return randomUUID(); }
function nowStr() { return new Date().toISOString(); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); }
function daysFromNow(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString(); }
function hashObj(obj) { return createHash("sha256").update(JSON.stringify(obj)).digest("hex"); }

const DELIVERY_ITEMS = [
  "documents",
  "payment_verified",
  "vehicle_preparation",
  "customer_confirmation",
  "handover_pack"
];

const CHECK_NOTES = {
  documents: {
    done: "Contract, registration transfer and RWC verified",
    pending: "Awaiting signed transfer paperwork from customer"
  },
  payment_verified: {
    done: "EFT settlement receipt confirmed by accounts",
    pending: "Finance payout letter pending approval"
  },
  vehicle_preparation: {
    done: "PDI complete, tint & mats fitted, final detail done",
    pending: "In wash bay - detail and accessory check in progress"
  },
  customer_confirmation: {
    done: "Customer confirmed collection slot with advisor",
    pending: "SMS sent to customer to confirm arrival time"
  },
  handover_pack: {
    done: "Spare keys, manuals, roadside assist pack in glovebox",
    pending: "Awaiting duplicate key coding"
  }
};

async function seedHandoverLane() {
  console.log("Connecting to MongoDB...");
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DATABASE);
  console.log("Connected to:", MONGODB_DATABASE);

  const org = await db.collection("organisations").findOne({});
  if (!org) throw new Error("No organisation found.");
  const orgId = org.id;

  const sites = await db.collection("sites").find({ organisation_id: orgId }).toArray();
  const memberships = await db.collection("memberships").find({ organisation_id: orgId }).toArray();
  const adminUserId = memberships.find(m => m.role === "ADMIN")?.user_id || memberships[0]?.user_id || uuid();

  // Clear existing delivery plans, handover items, and active stock reservations to reseed cleanly
  await db.collection("delivery_plans").deleteMany({ organisation_id: orgId });
  await db.collection("handover_items").deleteMany({ organisation_id: orgId });
  await db.collection("stock_reservations").deleteMany({ organisation_id: orgId });
  console.log("Cleared existing delivery_plans, handover_items, and stock_reservations.");

  // Get deals that are approved or submitted and convert them to approved so they qualify for deliveries
  const candidateDeals = await db.collection("sales_deals").find({
    organisation_id: orgId,
    status: { $in: ["approved", "submitted", "won"] }
  }).toArray();

  console.log(`Found ${candidateDeals.length} candidate deals for delivery plans.`);

  // Make sure at least 25-30 deals across pilot sites are approved
  let count = 0;
  const newDeliveryPlans = [];
  const newReservations = [];
  const newHandoverItems = [];

  for (const deal of candidateDeals) {
    // Ensure the stock vehicle exists and is available
    const stock = await db.collection("stock_vehicles").findOne({ id: deal.stock_id });
    if (!stock) continue;

    // Ensure deal is approved and versions align
    const dealVersion = deal.version || 0;
    const stockVersion = stock.version || 0;

    await db.collection("sales_deals").updateOne(
      { _id: deal._id },
      {
        $set: {
          status: "approved",
          stock_version: stockVersion,
          version: dealVersion,
          updated_at: nowStr()
        }
      }
    );

    const lead = await db.collection("sales_leads").findOne({ id: deal.lead_id });
    const site = sites.find(s => s.id === deal.site_id);
    const scheduledDays = 1 + (count % 10);
    const scheduledAt = daysFromNow(scheduledDays);
    const reservationExpiry = daysFromNow(scheduledDays + 3); // Reservation covers delivery time

    // Create active stock reservation covering the delivery
    const resId = uuid();
    const resRow = {
      _id: resId,
      id: resId,
      organisation_id: orgId,
      site_id: deal.site_id,
      lead_id: deal.lead_id,
      customer_id: deal.customer_id,
      deal_id: deal.id,
      stock_id: deal.stock_id,
      brand_id: deal.brand_id,
      status: "active",
      expires_at: reservationExpiry,
      ended_at: null,
      reason: `Reserved for scheduled delivery (${stock.make} ${stock.model})`,
      created_by: adminUserId,
      version: 0,
      create_key: `seed-res-${resId}`,
      create_hash: hashObj({ dealId: deal.id, stockId: deal.stock_id }),
      created_at: daysAgo(2),
      updated_at: daysAgo(1),
      ...(deal.integration_mode ? { integration_mode: deal.integration_mode } : {})
    };
    newReservations.push(resRow);

    // Build checklist: mix of 5/5 (Ready), 4/5 (Needs attention), 3/5 (Needs attention)
    const checklist = {};
    const sitePlansCount = newDeliveryPlans.filter(p => p.site_id === deal.site_id).length;
    const numComplete = sitePlansCount % 3 === 0 ? 5 : sitePlansCount % 3 === 1 ? 4 : 3;

    DELIVERY_ITEMS.forEach((itemKey, idx) => {
      const isDone = idx < numComplete;
      checklist[itemKey] = {
        complete: isDone,
        note: isDone ? CHECK_NOTES[itemKey].done : CHECK_NOTES[itemKey].pending,
        updated_by: isDone ? adminUserId : null,
        updated_at: isDone ? daysAgo(1) : null
      };
    });

    const dpId = uuid();
    const deliveryPlan = {
      _id: dpId,
      id: dpId,
      organisation_id: orgId,
      site_id: deal.site_id,
      lead_id: deal.lead_id,
      customer_id: deal.customer_id,
      deal_id: deal.id,
      deal_version: dealVersion,
      stock_id: deal.stock_id,
      stock_label: `${stock.make} ${stock.model} (${stock.year}) · #${stock.stock_number || 'STK'}`,
      brand_id: deal.brand_id,
      scheduled_at: scheduledAt,
      notes: `Handover scheduled with ${lead?.title || 'customer'}. Customer opted for morning collection.`,
      status: "planned",
      checklist,
      created_by: adminUserId,
      version: 0,
      integration_mode: deal.integration_mode || "simulated",
      create_key: `seed-dp-${dpId}`,
      create_hash: hashObj({ dealId: deal.id }),
      created_at: daysAgo(3),
      updated_at: daysAgo(1)
    };

    newDeliveryPlans.push(deliveryPlan);

    const handoverId = uuid();
    const pdiStatus = sitePlansCount % 3 === 0 ? "completed" : sitePlansCount % 3 === 1 ? "in_progress" : "pending";
    const firstServiceStatus = sitePlansCount % 2 === 0 ? "booked" : "not_booked";
    const handoverItem = {
      _id: handoverId,
      id: handoverId,
      organisation_id: orgId,
      site_id: deal.site_id,
      brand_id: deal.brand_id,
      deal_id: deal.id,
      delivery_plan_id: dpId,
      customer_id: deal.customer_id,
      stock_id: deal.stock_id,
      vehicle_label: deliveryPlan.stock_label,
      scheduled_delivery_at: scheduledAt,
      pdi_due_date: daysFromNow(Math.max(0, scheduledDays - 2)),
      pdi_status: pdiStatus,
      accessories_status: pdiStatus === "completed" ? "ready" : "pending",
      first_service_status: firstServiceStatus,
      status: "active",
      created_by: adminUserId,
      updated_at: nowStr(),
      created_at: daysAgo(3),
      version: 0,
      integration_mode: deal.integration_mode || "simulated"
    };
    newHandoverItems.push(handoverItem);

    count++;
  }

  if (newReservations.length > 0) {
    await db.collection("stock_reservations").insertMany(newReservations);
    console.log(`Inserted ${newReservations.length} active stock_reservations.`);
  }

  if (newDeliveryPlans.length > 0) {
    await db.collection("delivery_plans").insertMany(newDeliveryPlans);
    console.log(`Inserted ${newDeliveryPlans.length} delivery_plans.`);
  }

  if (newHandoverItems.length > 0) {
    await db.collection("handover_items").insertMany(newHandoverItems);
    console.log(`Inserted ${newHandoverItems.length} handover_items.`);
  }

  // Verify counts
  const finalDp = await db.collection("delivery_plans").countDocuments({ organisation_id: orgId });
  const finalRes = await db.collection("stock_reservations").countDocuments({ organisation_id: orgId, status: "active" });
  console.log(`\nVerified: ${finalDp} delivery plans and ${finalRes} active reservations now in database.`);

  await client.close();
  console.log("Seeding Handover Lane completed successfully!");
}

seedHandoverLane().catch(err => {
  console.error("Failed to seed Handover Lane:", err);
  process.exit(1);
});
