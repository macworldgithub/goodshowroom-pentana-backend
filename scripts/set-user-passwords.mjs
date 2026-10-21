import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: suData } = await supabase.auth.admin.listUsers();
const users = suData?.users || [];

const DEFAULT_PW = "GoodShowroom123!";

for (const u of users) {
  const { error } = await supabase.auth.admin.updateUserById(u.id, {
    password: DEFAULT_PW,
    email_confirm: true,
  });
  if (error) {
    console.error(`Failed to set password for ${u.email}:`, error.message);
  } else {
    console.log(`Password set for ${u.email}`);
  }
}

console.log(`\nAll users updated with standard password: ${DEFAULT_PW}`);
