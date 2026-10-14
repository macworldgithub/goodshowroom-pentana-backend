export type Role = 'ADMIN' | 'SALES' | 'SERVICE';

const crmPermissions = ['customers.read', 'customers.write', 'tasks.read', 'tasks.write', 'messages.read', 'messages.write', 'messages.send'];
export const EXTRA_PERMISSIONS = [
  'customers.view_team', 'customers.assign', 'tasks.view_team', 'tasks.assign',
  'sales.view_team', 'sales.assign_leads', 'service.view_team', 'service.assign_work',
] as const;
export const ROLE_PERMISSIONS: Record<Role, readonly string[]> = {
  ADMIN: [...crmPermissions, ...EXTRA_PERMISSIONS, 'users.manage', 'audit.read', 'imports.manage', 'customers.export', 'sales.read', 'sales.write', 'sales.approve_deals', 'stock.manage', 'service.read', 'service.write'],
  SALES: [...crmPermissions, 'sales.read', 'sales.write'],
  SERVICE: [...crmPermissions, 'service.read', 'service.write'],
};

export function permissionsFor(grants: { role: Role; extra_permissions: string[] }[]): string[] {
  return [...new Set(grants.flatMap(grant => [
    ...(ROLE_PERMISSIONS[grant.role] ?? []),
    ...grant.extra_permissions.filter(permission => (EXTRA_PERMISSIONS as readonly string[]).includes(permission)),
  ]))].sort();
}
