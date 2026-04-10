import { describe, it, expect, vi } from 'vitest';
import { resolvePhoneFromJid, type LidResolver } from '../../baileys/jid-resolver.js';

function mockResolver(mapping: Record<string, string>): LidResolver {
  return {
    getPNForLID: vi.fn(async (lid: string) => mapping[lid] ?? null),
  };
}

describe('resolvePhoneFromJid', () => {
  // ── Phone-based JIDs (no resolution needed) ──

  it('returns phone from standard JID', async () => {
    const result = await resolvePhoneFromJid('51903429745@s.whatsapp.net', null);
    expect(result).toBe('51903429745');
  });

  it('strips device suffix from phone JID', async () => {
    const result = await resolvePhoneFromJid('51903429745:0@s.whatsapp.net', null);
    expect(result).toBe('51903429745');
  });

  // ── LID-based JIDs (need resolution) ──

  it('resolves LID to phone via resolver', async () => {
    const resolver = mockResolver({
      '48915483205670@lid': '51903429745@s.whatsapp.net',
    });
    const result = await resolvePhoneFromJid('48915483205670@lid', resolver);
    expect(result).toBe('51903429745');
  });

  it('strips device suffix from resolved phone', async () => {
    const resolver = mockResolver({
      '48915483205670:0@lid': '51903429745:0@s.whatsapp.net',
    });
    const result = await resolvePhoneFromJid('48915483205670:0@lid', resolver);
    expect(result).toBe('51903429745');
  });

  // ── Fallbacks ──

  it('returns raw LID user when resolver is null', async () => {
    const result = await resolvePhoneFromJid('48915483205670@lid', null);
    expect(result).toBe('48915483205670');
  });

  it('returns raw LID user when getPNForLID returns null', async () => {
    const resolver = mockResolver({});
    const result = await resolvePhoneFromJid('48915483205670@lid', resolver);
    expect(result).toBe('48915483205670');
  });

  // ── Edge cases ──

  it('returns group id from group JID', async () => {
    const result = await resolvePhoneFromJid('120363123456789@g.us', null);
    expect(result).toBe('120363123456789');
  });

  it('returns undefined for undefined input', async () => {
    const result = await resolvePhoneFromJid(undefined, null);
    expect(result).toBeUndefined();
  });
});
