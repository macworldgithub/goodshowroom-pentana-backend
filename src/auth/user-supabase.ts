/**
 * Supabase admin client has been removed.
 * User provisioning is now handled directly via MongoDB and the native auth system.
 * This file is kept as a stub to prevent compilation errors if old test/spec files reference it.
 */
export function createAdminSupabaseClient(): never {
  throw new Error('Supabase admin client has been removed. Use the native auth system (UserProvisioningService, AuthService).');
}
