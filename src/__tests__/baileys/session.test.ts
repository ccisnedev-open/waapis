import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { BaileysSession } from '../../baileys/session.js';

class MockSocket {
  user = { id: '51999000000@s.whatsapp.net', name: 'Test Simulator' };
  end = vi.fn(async () => {});
  logout = vi.fn(async () => {});
  sendMessage = vi.fn(async () => ({ key: { id: 'mock_msg_id' }, status: 1 }));
  sendPresenceUpdate = vi.fn(async () => {});
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
});
