/** Role vocabulary shared by the database enum, routes and OpenAPI schemas. */
export const ROLES = ['admin', 'writer', 'reader'] as const;

export type Role = (typeof ROLES)[number];

/** Higher rank implies every capability of the lower ranks. */
const RANK: Record<Role, number> = { reader: 1, writer: 2, admin: 3 };

export function satisfiesRole(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}
