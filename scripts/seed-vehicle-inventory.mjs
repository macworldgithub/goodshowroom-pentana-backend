import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

// Load environment variables
if (fs.existsSync('.env')) {
  process.loadEnvFile('.env');
}

const BRAND_NAMES = {
  ALFAROMEO: 'Alfa Romeo',
  ALLMAKES: 'All Makes',
  AUDI: 'Audi',
  BMW: 'BMW',
  BYD: 'BYD',
  CHERY: 'Chery',
  CHRYSLERJEEP: 'Chrysler Jeep',
  CITROEN: 'Citroen',
  DENZA: 'Denza',
  FORD: 'Ford',
  FPV: 'FPV',
  GAC: 'GAC',
  GEELY: 'Geely',
  GENESIS: 'Genesis',
  GREATWALL: 'GWM',
  HOLDEN: 'Holden',
  HONDA: 'Honda',
  HSV: 'HSV',
  HYUNDAI: 'Hyundai',
  ISUZUUTE: 'Isuzu UTE',
  JAGUAR: 'Jaguar',
  KIA: 'Kia',
  LANDROVER: 'Land Rover',
  LDV: 'LDV',
  LEPAS: 'Lepas',
  LEXUS: 'Lexus',
  MAHINDRA: 'Mahindra',
  MAZDA: 'Mazda',
  MERCEDESBENZ: 'Mercedes-Benz',
  MG: 'MG',
  MINI: 'Mini',
  MITSUBISHI: 'Mitsubishi',
  NISSAN: 'Nissan',
  OMODAJAECOO: 'Omoda Jaecoo',
  PEUGEOT: 'Peugeot',
  RENAULT: 'Renault',
  SAME: 'Same',
  SEADOO: 'Sea-Doo',
  SKODA: 'Skoda',
  SUBARU: 'Subaru',
  SUZUKI: 'Suzuki',
  TESLA: 'Tesla',
  TOYOTA: 'Toyota',
  VOLKSWAGEN: 'Volkswagen',
  VOLVO: 'Volvo',
  XPENG: 'XPeng',
};

function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

function parseYear(rawYear, desc) {
  if (rawYear) {
    const n = parseInt(rawYear, 10);
    if (!isNaN(n)) {
      if (n >= 1900 && n <= 2030) return n;
      if (n >= 50 && n <= 99) return 1900 + n;
      if (n >= 0 && n < 50) return 2000 + n;
    }
  }
  if (desc) {
    const myMatch = desc.match(/\bMY(\d{2})\b/i);
    if (myMatch) {
      const n = parseInt(myMatch[1], 10);
      return 2000 + n;
    }
    const yearMatch = desc.match(/\b(20[12]\d)\b/);
    if (yearMatch) {
      return parseInt(yearMatch[1], 10);
    }
  }
  return 2025;
}

function parseBodyType(desc, carline) {
  const text = `${carline || ''} ${desc || ''}`.toUpperCase();
  if (/\b(SUV)\b/.test(text)) return 'SUV';
  if (/\b(SEDAN|SDN)\b/.test(text)) return 'Sedan';
  if (/\b(HATCHBACK|HATCH|5DR|3DR)\b/.test(text)) return 'Hatchback';
  if (/\b(WAGON|WAG)\b/.test(text)) return 'Wagon';
  if (/\b(UTE|DUAL CAB|SPACE CAB|SINGLE CAB|D\/CAB|S\/CAB|C\/CHAS|CAB CHASSIS)\b/.test(text)) return 'Ute';
  if (/\b(COUPE|CPE)\b/.test(text)) return 'Coupe';
  if (/\b(CONVERTIBLE|CABRIOLET)\b/.test(text)) return 'Convertible';
  if (/\b(VAN)\b/.test(text)) return 'Van';
  return 'SUV';
}

function parseFuelType(desc) {
  const text = (desc || '').toUpperCase();
  if (/\b(PHEV|HEV|HYBRID|DHT|CSH)\b/.test(text)) return 'Hybrid';
  if (/\b(EV|ELECTRIC|BEV)\b/.test(text)) return 'Electric';
  if (/\b(DIESEL|DT|DTT|D\/T|TURBO DIESEL)\b/.test(text)) return 'Diesel';
  return 'Petrol';
}

function parseTransmission(desc) {
  const text = (desc || '').toUpperCase();
  if (/\b(MANUAL|MAN|M\/T|6MT|5MT)\b/.test(text)) return 'Manual';
  return 'Automatic';
}

function parsePrice(rawPrice) {
  if (!rawPrice) return null;
  const cleaned = rawPrice.replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  if (isNaN(num) || num <= 0) return null;
  return Math.round(num * 100);
}

function parseStatus(rawStatus) {
  const st = (rawStatus || '').toUpperCase().trim();
  if (st === 'SOLD') return 'sold';
  if (st === 'WHOLESALE' || st === 'DLR TRADE') return 'unavailable';
  return 'available';
}

function parseOdometer(rawOdo) {
  if (!rawOdo) return 0;
  const cleaned = rawOdo.replace(/[^0-9]/g, '');
  const num = parseInt(cleaned, 10);
  if (isNaN(num) || num < 0) return 0;
  return Math.min(num, 5000000);
}

function sanitizeText(val, maxLen) {
  if (!val) return null;
  const clean = String(val).trim();
  if (!clean) return null;
  return clean.slice(0, maxLen);
}

async function seedVehicleInventory() {
  console.log('Connecting to MongoDB...');
  const uri = process.env.MONGODB_URI;
  const databaseName = process.env.MONGODB_DATABASE;
  if (!uri || !databaseName) {
    throw new Error('MONGODB_URI and MONGODB_DATABASE must be set in .env');
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(databaseName);
  console.log(`Connected to MongoDB database: ${databaseName}`);

  // Get organization
  const org = await db.collection('organisations').findOne({});
  if (!org) {
    throw new Error('No organisation found in database');
  }
  const organisationId = org.id;
  console.log(`Using organisation: ${org.name} (${organisationId})`);

  // Get admin user for created_by
  const adminMembership = await db.collection('memberships').findOne({ role: 'ADMIN' });
  const createdBy = adminMembership?.user_id || randomUUID();
  console.log(`Using created_by user ID: ${createdBy}`);

  // Fetch all sites and index by their 2-digit prefix
  const sites = await db.collection('sites').find({ organisation_id: organisationId }).toArray();
  const sitePrefixMap = new Map(); // '01' -> site doc
  for (const site of sites) {
    const match = site.name.match(/^(\d+)\|/);
    if (match) {
      sitePrefixMap.set(match[1], site);
    }
  }
  console.log(`Matched ${sitePrefixMap.size} sites by prefix from ${sites.length} total sites`);

  // Find or create brands
  console.log('\nChecking / creating brands...');
  const existingBrands = await db.collection('brands').find({ organisation_id: organisationId }).toArray();
  const brandMap = new Map(); // brandCode -> brand doc
  for (const b of existingBrands) {
    // Find matching code
    for (const [code, name] of Object.entries(BRAND_NAMES)) {
      if (b.name.toLowerCase() === name.toLowerCase()) {
        brandMap.set(code, b);
      }
    }
  }

  const now = new Date().toISOString();
  const newBrandsToInsert = [];
  for (const [code, name] of Object.entries(BRAND_NAMES)) {
    if (!brandMap.has(code)) {
      const id = randomUUID();
      const newBrand = {
        _id: id,
        id,
        organisation_id: organisationId,
        name,
        created_at: now,
        updated_at: now,
      };
      newBrandsToInsert.push(newBrand);
      brandMap.set(code, newBrand);
    }
  }

  if (newBrandsToInsert.length > 0) {
    await db.collection('brands').insertMany(newBrandsToInsert);
    console.log(`Created ${newBrandsToInsert.length} new brands in database`);
  } else {
    console.log('All brands already present');
  }

  // Read all 280 files from 'booran data'
  const dataDir = 'booran data';
  const files = fs.readdirSync(dataDir).sort();
  console.log(`\nScanning ${files.length} CSV files in '${dataDir}'...`);

  // Map to track which brands are used at each site
  const siteBrandIds = new Map(); // siteId -> Set<brandId>

  const vehiclesToInsert = [];
  const seenSiteStocks = new Map(); // siteId -> Set<stockNumber>
  let skippedFiles = 0;
  let emptyRowsCount = 0;

  for (const file of files) {
    const m = file.match(/^(\d+)_(.+)_([^_]+)_(New|Used)\.csv$/);
    if (!m) {
      console.warn(`File ${file} does not match expected naming convention, skipping`);
      skippedFiles++;
      continue;
    }

    const sitePrefix = m[1];
    const brandCode = m[3];
    const isNew = m[4] === 'New';

    const site = sitePrefixMap.get(sitePrefix);
    if (!site) {
      console.warn(`No site found for prefix ${sitePrefix} (file: ${file}), skipping`);
      continue;
    }

    const brand = brandMap.get(brandCode);
    if (!brand) {
      console.warn(`No brand found for code ${brandCode} (file: ${file}), skipping`);
      continue;
    }

    if (!siteBrandIds.has(site.id)) siteBrandIds.set(site.id, new Set());
    siteBrandIds.get(site.id).add(brand.id);

    if (!seenSiteStocks.has(site.id)) seenSiteStocks.set(site.id, new Set());
    const stockSet = seenSiteStocks.get(site.id);

    const filePath = path.join(dataDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length <= 1) {
      continue;
    }

    for (let i = 1; i < lines.length; i++) {
      const parts = parseCsvLine(lines[i]);
      if (!parts.length || !parts[0]) {
        emptyRowsCount++;
        continue;
      }

      const stockNumber = parts[0].trim().toUpperCase();
      if (!stockNumber) {
        emptyRowsCount++;
        continue;
      }

      if (stockSet.has(stockNumber)) {
        // Skip duplicate stock within same site
        continue;
      }
      stockSet.add(stockNumber);

      let carline = '';
      let desc = '';
      let rawYear = '';
      let colour = '';
      let rawPrice = '';
      let rawStatus = '';
      let odometerKm = 0;

      if (isNew) {
        // Header: stock#,carline,description,fa,colour,loc,dest loc,list price,age,age,deal,status,open ro/po
        carline = parts[1] || '';
        desc = parts[2] || '';
        colour = parts[4] || '';
        rawPrice = parts[7] || '';
        rawStatus = parts[11] || '';
        odometerKm = 0;
      } else {
        // Header: stock no,age,year,carline,description,reg no,odometer,colour,list price,loc,dest loc,status,open ro/po
        rawYear = parts[2] || '';
        carline = parts[3] || '';
        desc = parts[4] || '';
        odometerKm = parseOdometer(parts[6]);
        colour = parts[7] || '';
        rawPrice = parts[8] || '';
        rawStatus = parts[11] || '';
      }

      const year = parseYear(rawYear, desc);
      const make = BRAND_NAMES[brandCode] || brandCode;
      const model = sanitizeText(carline || desc || make, 100);
      const variant = sanitizeText(desc, 100);
      const bodyType = parseBodyType(desc, carline);
      const fuelType = parseFuelType(desc);
      const transmission = parseTransmission(desc);
      const priceCents = parsePrice(rawPrice);
      const status = parseStatus(rawStatus);
      const cleanColour = sanitizeText(colour, 100);

      const id = randomUUID();
      const createKey = `seed-stock-${sitePrefix}-${stockNumber}`;
      const hash = createHash('sha256')
        .update(JSON.stringify({ siteId: site.id, brandId: brand.id, stockNumber, make, model }))
        .digest('hex');

      const vehicle = {
        _id: id,
        id,
        organisation_id: organisationId,
        site_id: site.id,
        brand_id: brand.id,
        stock_number: stockNumber,
        make,
        model,
        variant,
        year,
        odometer_km: odometerKm,
        vin: null,
        colour: cleanColour,
        body_type: bodyType,
        fuel_type: fuelType,
        transmission,
        price_cents: priceCents,
        currency: 'AUD',
        status,
        source: 'simulated',
        integration_mode: 'simulated',
        version: 0,
        created_at: now,
        updated_at: now,
        created_by: createdBy,
        create_key: createKey,
        create_hash: hash,
      };

      vehiclesToInsert.push(vehicle);
    }
  }

  console.log(`\nPrepared ${vehiclesToInsert.length} vehicles from all CSV files`);

  // Update brand_ids for all sites
  console.log('\nUpdating site brand mappings in database...');
  for (const [siteId, brandIdSet] of siteBrandIds.entries()) {
    const brandIds = Array.from(brandIdSet);
    await db.collection('sites').updateOne(
      { id: siteId },
      { $set: { brand_ids: brandIds, updated_at: now } }
    );
    const siteObj = sites.find(s => s.id === siteId);
    console.log(`Site '${siteObj?.name}' (${siteId}) mapped with ${brandIds.length} brands`);
  }

  // Also map all brands to "Pilot Site" so pilot tests have full access
  const pilotSite = sites.find(s => s.name === 'Pilot Site');
  if (pilotSite) {
    const allBrandIds = Array.from(new Set(Array.from(siteBrandIds.values()).flatMap(s => Array.from(s))));
    await db.collection('sites').updateOne(
      { id: pilotSite.id },
      { $set: { brand_ids: allBrandIds, updated_at: now } }
    );
    console.log(`Pilot Site (${pilotSite.id}) mapped with ${allBrandIds.length} brands`);
  }

  // Replace current vehicle inventory in MongoDB
  console.log('\nReplacing vehicle inventory in MongoDB...');
  const deleteResult = await db.collection('stock_vehicles').deleteMany({});
  console.log(`Cleared existing stock_vehicles: ${deleteResult.deletedCount} removed`);

  // Insert in batches of 1,000
  const BATCH_SIZE = 1000;
  let inserted = 0;
  for (let i = 0; i < vehiclesToInsert.length; i += BATCH_SIZE) {
    const batch = vehiclesToInsert.slice(i, i + BATCH_SIZE);
    await db.collection('stock_vehicles').insertMany(batch);
    inserted += batch.length;
    console.log(`Inserted ${inserted} / ${vehiclesToInsert.length} vehicles...`);
  }

  // Verification
  const totalCount = await db.collection('stock_vehicles').countDocuments();
  console.log(`\nVerification: stock_vehicles collection now has ${totalCount} documents`);

  // Breakdown by status
  const statusCounts = await db.collection('stock_vehicles').aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();
  console.log('Status breakdown:', statusCounts);

  // Breakdown by site
  const siteCounts = await db.collection('stock_vehicles').aggregate([
    { $group: { _id: '$site_id', count: { $sum: 1 } } }
  ]).toArray();
  console.log(`Seeded vehicles across ${siteCounts.length} sites:`);
  for (const s of siteCounts) {
    const siteName = sites.find(x => x.id === s._id)?.name || s._id;
    console.log(`  - ${siteName}: ${s.count} vehicles`);
  }

  await client.close();
  console.log('\nSeeding completed successfully!');
}

seedVehicleInventory().catch(err => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
