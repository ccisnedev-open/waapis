import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { BaileysSession } from '../../baileys/session.js';
import type { LidResolver } from '../../baileys/jid-resolver.js';

const mockLidMapping = {
  getPNForLID: vi.fn(async () => null),
  storeLIDPNMappings: vi.fn(),
  getLIDForPN: vi.fn(async () => null),
  getLIDsForPNs: vi.fn(async () => null),
};

class MockSocket {
  user = { id: '51999000000@s.whatsapp.net', name: 'Test Simulator' };
  end = vi.fn(async () => {});
  logout = vi.fn(async () => {});
  sendMessage = vi.fn(async () => ({ key: { id: 'mock_msg_id' }, status: 1 }));
  sendPresenceUpdate = vi.fn(async () => {});
  signalRepository = { lidMapping: mockLidMapping };
  ev = new EventEmitter();
}

// Mock the Baileys module — we don't want real WhatsApp connections in tests
vi.mock('@whiskeysockets/baileys', () => {
  return {
    default: vi.fn(() => {
      const sock = new MockSocket();
      setTimeout(() => {
        sock.ev.emit('connection.update', { connection: 'open' });
      }, 10);
      return sock;
    }),
    useMultiFileAuthState: vi.fn(async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: vi.fn(async () => {}),
    })),
    DisconnectReason: { loggedOut: 401 },
    Browsers: { ubuntu: (name: string) => [name, 'Ubuntu', '22.04'] },
    fetchLatestBaileysVersion: vi.fn(async () => ({ version: [2, 3000, 1035194821], isLatest: true })),
    makeWASocket: vi.fn(() => {
      const sock = new MockSocket();
      setTimeout(() => {
        sock.ev.emit('connection.update', { connection: 'open' });
      }, 10);
      return sock;
    }),
  };
});

describe('BaileysSession', () => {
  let session: BaileysSession;

  beforeEach(() => {
    session = new BaileysSession({
      authDir: './test_auth',
      onInboundMessage: vi.fn(),
      onStatusUpdate: vi.fn(),
    });
  });

  it('starts disconnected before connect() is called', () => {
    expect(session.isConnected()).toBe(false);
    expect(session.currentQR()).toBeUndefined();
    expect(session.phoneNumber()).toBeUndefined();
  });

  it('exposes the session status provider interface', () => {
    const provider = session.asStatusProvider();
    expect(provider.isConnected).toBeTypeOf('function');
    expect(provider.phoneNumber).toBeTypeOf('function');
  });

  it('exposes the message sender interface', () => {
    const messageSender = session.asMessageSender();
    expect(messageSender.sendTextMessage).toBeTypeOf('function');
  });

  it('connect() resolves without throwing', async () => {
    await expect(session.connect()).resolves.not.toThrow();
  });

  it('becomes connected after successful connection', async () => {
    await session.connect();
    // Wait for the simulated connection.update event
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(session.isConnected()).toBe(true);
  });

  it('stores QR code when connection.update provides one', async () => {
    await session.connect();
    // Manually trigger a QR event
    session['emitConnectionUpdate']({ qr: 'mock_qr_string' });
    expect(session.currentQR()).toBe('mock_qr_string');
  });

  it('clears QR code when connection becomes open', async () => {
    await session.connect();
    session['emitConnectionUpdate']({ qr: 'mock_qr_string' });
    expect(session.currentQR()).toBe('mock_qr_string');

    session['emitConnectionUpdate']({ connection: 'open' });
    expect(session.currentQR()).toBeUndefined();
  });

  it('passes lidMapping as second argument to onInboundMessage', async () => {
    const onInbound = vi.fn();
    const sessionWithSpy = new BaileysSession({
      authDir: './test_auth',
      onInboundMessage: onInbound,
      onStatusUpdate: vi.fn(),
    });

    await sessionWithSpy.connect();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Simulate an inbound message via the socket's messages.upsert event
    const sock = sessionWithSpy.socket()!;
    (sock as any).ev.emit('messages.upsert', {
      messages: [
        { key: { remoteJid: '51999000001@s.whatsapp.net', fromMe: false, id: 'test1' }, message: {} },
      ],
      type: 'notify',
    });

    expect(onInbound).toHaveBeenCalledOnce();
    expect(onInbound).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.objectContaining({ id: 'test1' }) }),
      expect.objectContaining({ getPNForLID: expect.any(Function) }),
    );
  });

  it('passes null as lidResolver when socket has no signalRepository', async () => {
    const onInbound = vi.fn();
    const sessionWithSpy = new BaileysSession({
      authDir: './test_auth',
      onInboundMessage: onInbound,
      onStatusUpdate: vi.fn(),
    });

    await sessionWithSpy.connect();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Remove signalRepository to simulate missing property
    const sock = sessionWithSpy.socket()!;
    delete (sock as any).signalRepository;

    (sock as any).ev.emit('messages.upsert', {
      messages: [
        { key: { remoteJid: '51999000001@s.whatsapp.net', fromMe: false, id: 'test2' }, message: {} },
      ],
      type: 'notify',
    });

    expect(onInbound).toHaveBeenCalledOnce();
    expect(onInbound).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.objectContaining({ id: 'test2' }) }),
      null,
    );
  });
});
