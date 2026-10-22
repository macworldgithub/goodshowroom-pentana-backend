import { MongoClient } from 'mongodb';

const GS_URI = 'mongodb+srv://abdulahadnauman10_db_user:Neximet123@cluster0.qeczbwo.mongodb.net/';
const GS_DB = 'goodshowroom-pentana';
const FLWUP_URI = 'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/flwup_crm';

function normPhone(p) {
  if (!p) return null;
  let digits = String(p).replace(/\D/g, '');
  if (digits.startsWith('61') && digits.length === 11) digits = '0' + digits.slice(2);
  return digits.length >= 8 ? digits : null;
}
function normEmail(e) {
  if (!e) return null;
  const clean = String(e).trim().toLowerCase();
  return clean.includes('@') ? clean : null;
}

async function checkMatches() {
  const gsClient = new MongoClient(GS_URI);
  const flwupClient = new MongoClient(FLWUP_URI);
  await gsClient.connect();
  await flwupClient.connect();

  const gsDb = gsClient.db(GS_DB);
  const flwupDb = flwupClient.db();

  const gsCusts = await gsDb.collection('customers').find({}).toArray();
  const leads = await flwupDb.collection('leads').find({}).toArray();

  for (const l of leads) {
    const lEmail = normEmail(l.customer_email);
    const lPhone = normPhone(l.customer_phone);
    for (const c of gsCusts) {
      const cEmail = normEmail(c.email);
      const cPhone = normPhone(c.phone);
      if ((lEmail && cEmail && lEmail === cEmail) || (lPhone && cPhone && lPhone === cPhone)) {
        console.log('Match found:');
        console.log('FLWup Lead:', { id: l._id, name: l.customer_name, email: l.customer_email, phone: l.customer_phone });
        console.log('GS Customer:', { id: c.id, name: `${c.first_name} ${c.last_name}`, email: c.email, phone: c.phone, source: c.source });
      }
    }
  }

  await gsClient.close();
  await flwupClient.close();
}
checkMatches();
