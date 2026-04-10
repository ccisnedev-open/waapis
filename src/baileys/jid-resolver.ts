/** Minimal interface for resolving LID → phone number via Baileys' LIDMappingStore. */
export interface LidResolver {
  getPNForLID(lid: string): Promise<string | null>;
}

/**
 * Extracts the user portion (phone number) from a JID, stripping domain and device suffixes.
 * Returns just the digits: "51903429745:0@s.whatsapp.net" → "51903429745".
 */
function extractUser(jid: string): string {
  return jid.replace(/@.*$/, '').replace(/:.*$/, '');
}

/**
 * Resolves a Baileys JID to a phone number string.
 *
 * - Phone JIDs (`@s.whatsapp.net`): strips domain and device, returns phone.
 * - LID JIDs (`@lid`): uses the resolver to map LID → phone. Falls back to raw LID user if
 *   the resolver is null or the mapping doesn't exist.
 * - Group JIDs (`@g.us`): strips domain, returns group id.
 * - undefined: returns undefined.
 */
export async function resolvePhoneFromJid(
  jid: string | undefined,
  lidResolver: LidResolver | null,
): Promise<string | undefined> {
  if (!jid) return undefined;

  const isLid = jid.includes('@lid');
  if (!isLid) return extractUser(jid);

  if (!lidResolver) return extractUser(jid);

  const resolved = await lidResolver.getPNForLID(jid);
  if (!resolved) return extractUser(jid);

  return extractUser(resolved);
}
