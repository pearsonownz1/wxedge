// Replit identity checks remain available to the unrelated OIDC auth routes.
export function isOwner(id: string | undefined): boolean {
  return !!process.env.CRM_OWNER_ID && id === process.env.CRM_OWNER_ID;
}
