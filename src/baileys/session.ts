import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import type { WASocket, BaileysEventMap, ConnectionState } from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import pino from 'pino';
import type { SessionStatusProvider } from '../routes/health.route.js';
import type { MessageSender } from '../routes/messages.route.js';

export interface BaileysSessionConfig {
  authDir: string;
  onInboundMessage: (message: any) => void;
  onStatusUpdate: (update: any) => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Manages the Baileys WhatsApp Web session lifecycle:
 * connect, disconnect, QR code tracking, and automatic reconnection.
 *
 * Decoupled from Express routes via the SessionStatusProvider and MessageSender interfaces,
 * so every consumer can be tested independently.
 */
export class BaileysSession {
  private sock: WASocket | null = null;
  private saveCreds: (() => Promise<void>) | null = null;
  private connected = false;
  private qrCode: string | undefined;
  private phone: string | undefined;
  private reconnectAttempts = 0;
  private readonly config: BaileysSessionConfig;
  private readonly logger = pino({ level: 'silent' });
  private readonly appLogger = pino({ transport: { target: 'pino-pretty' } });

  constructor(config: BaileysSessionConfig) {
    this.config = config;
  }

  /** Establishes the Baileys WebSocket connection and starts listening for events. */
  async connect(): Promise<void> {
    // Clean up any existing socket before creating a new one
    if (this.sock) {
      try { this.sock.ev.removeAllListeners(); await this.sock.end(undefined); } catch { /* ignore */ }
      this.sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir);
    this.saveCreds = saveCreds;

    // Fetch the latest WhatsApp Web version to avoid 405 Connection Failure
    const { version } = await fetchLatestBaileysVersion();
    this.appLogger.info('Using WhatsApp Web version: %s', version.join('.'));

    this.sock = makeWASocket({
      auth: state,
      version,
      browser: Browsers.ubuntu('HELP Simulator'),
      logger: this.logger,
    });

    this.sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      this.handleConnectionUpdate(update);
    });

    this.sock.ev.on('creds.update', async () => {
      await this.saveCreds?.();
    });

    this.sock.ev.on('messages.upsert', (event: BaileysEventMap['messages.upsert']) => {
      for (const msg of event.messages) {
        if (msg.key.fromMe) continue;
        this.config.onInboundMessage(msg);
      }
    });
  }

  /** Closes the session. If clearAuth is true, deletes stored credentials. */
  async disconnect(clearAuth = false): Promise<void> {
    if (this.sock) {
      this.sock.ev.removeAllListeners();
      if (clearAuth) {
        try { await this.sock.logout(); } catch { /* already disconnected */ }
        // Remove auth folder so next connect() generates a fresh QR
        const { rmSync } = await import('node:fs');
        try { rmSync(this.config.authDir, { recursive: true, force: true }); } catch { /* ignore */ }
      } else {
        try { await this.sock.end(undefined); } catch { /* ignore */ }
      }
    }
    this.sock = null;
    this.connected = false;
    this.qrCode = undefined;
    this.phone = undefined;
    this.reconnectAttempts = 0;
  }

  isConnected(): boolean {
    return this.connected;
  }

  currentQR(): string | undefined {
    return this.qrCode;
  }

  phoneNumber(): string | undefined {
    return this.phone;
  }

  /** Returns the socket for direct use (e.g., sending messages). */
  socket(): WASocket | null {
    return this.sock;
  }

  /** Adapter so Express routes can query session status without coupling to Baileys. */
  asStatusProvider(): SessionStatusProvider {
    return {
      isConnected: () => this.isConnected(),
      phoneNumber: () => this.phoneNumber(),
    };
  }

  /** Adapter so Express routes can send messages without coupling to Baileys. */
  asMessageSender(): MessageSender {
    return {
      sendTextMessage: async (phoneNumber: string, text: string) => {
        if (!this.sock) throw new Error('Session not connected');
        const jid = `${phoneNumber}@s.whatsapp.net`;
        await this.sock.sendMessage(jid, { text });
      },
    };
  }

  /**
   * Exposed for testing — simulates a connection.update event.
   * In production, Baileys emits this automatically.
   */
  /* @internal */
  emitConnectionUpdate(update: Partial<ConnectionState>): void {
    this.handleConnectionUpdate(update);
  }

  // ── Private ──

  private handleConnectionUpdate(update: Partial<ConnectionState>): void {
    const { connection, lastDisconnect, qr } = update as any;

    if (qr) {
      this.qrCode = qr;
      this.connected = false;
      this.appLogger.info('QR code received — open http://localhost:3001/dashboard to scan');
    }

    if (connection === 'open') {
      this.connected = true;
      this.qrCode = undefined;
      this.reconnectAttempts = 0;
      this.phone = this.sock?.user?.id?.replace(/@.*/, '').replace(/:.*/, '');
      this.appLogger.info('WhatsApp connected — phone: %s', this.phone);
    }

    if (connection === 'close') {
      this.connected = false;

      const error = lastDisconnect?.error;
      const statusCode = (error as Boom)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      this.appLogger.error('Connection closed — statusCode=%d error=%s', statusCode, error?.message ?? 'unknown');

      if (isLoggedOut) {
        this.qrCode = undefined;
      }

      if (!isLoggedOut && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts++;
        const backoffMs = Math.min(Math.pow(2, this.reconnectAttempts) * 1000, 30_000);
        this.appLogger.info('Connection closed — reconnecting in %dms (attempt %d/%d)', backoffMs, this.reconnectAttempts, MAX_RECONNECT_ATTEMPTS);
        setTimeout(() => this.connect(), backoffMs);
      } else if (isLoggedOut) {
        this.appLogger.warn('Logged out — scan QR again via dashboard');
      } else {
        this.appLogger.error('Max reconnection attempts reached (%d)', MAX_RECONNECT_ATTEMPTS);
      }
    }
  }
}
