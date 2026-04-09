import { loadConfig } from './config.js';
import { loadState, saveState } from './state/persistence.js';
import { BaileysSession } from './baileys/session.js';
import { normalizeInboundMessage } from './baileys/event-normalizer.js';
import { dispatchWebhook } from './webhooks/webhook-dispatcher.js';
import { registerMedia } from './media/media-store.js';
import { createApp } from './app.js';
import pino from 'pino';

const logger = pino({ transport: { target: 'pino-pretty' } });

// ── 1. Load configuration ──
const config = loadConfig();
logger.info('Config loaded — port=%d phone=%s', config.port, config.phoneNumber);

// ── 2. Restore state from JSON ──
const STATE_FILE = './state.json';
const state = loadState(STATE_FILE);
logger.info('State restored from %s', STATE_FILE);

// Persist state every 10 seconds
const persistInterval = setInterval(() => {
  saveState(state, STATE_FILE);
}, 10_000);

// ── 3. Create Baileys session ──
const session = new BaileysSession({
  authDir: './auth_info_baileys',
  onInboundMessage: async (msg: any) => {
    try {
      const payload = normalizeInboundMessage(msg, {
        phoneNumberId: config.phoneNumberId,
        displayPhoneNumber: config.phoneNumber,
        wabaId: config.wabaId,
      });

      // Record inbound for 24h window tracking
      const from = msg.key?.remoteJid?.replace(/@.*/, '');
      if (from) {
        state.recordInbound(from, Date.now());
      }

      // Eager media download: if the message has media, download and register it
      // (In a real Baileys session, we'd use downloadMediaMessage here)

      if (config.callbackUrl && config.appSecret) {
        await dispatchWebhook(payload, config.callbackUrl, config.appSecret);
        logger.info('Webhook dispatched for message from %s', from);
      }
    } catch (err) {
      logger.error(err, 'Failed to process inbound message');
    }
  },
  onStatusUpdate: async (update: any) => {
    logger.info('Status update: %o', update);
  },
});

// ── 4. Create Express app ──
const app = createApp(config, state, session as any);

// ── 5. Start server ──
const server = app.listen(config.port, () => {
  logger.info('WhatsApp API Simulator listening on http://localhost:%d', config.port);
  logger.info('Dashboard: http://localhost:%d/dashboard', config.port);
});

// ── 6. Connect to WhatsApp ──
session.connect().then(() => {
  logger.info('Baileys session connection initiated');
}).catch((err) => {
  logger.error(err, 'Failed to initiate Baileys connection');
});

// ── 7. Graceful shutdown ──
function gracefulShutdown(signal: string) {
  logger.info('Received %s — shutting down gracefully', signal);

  clearInterval(persistInterval);
  saveState(state, STATE_FILE);
  logger.info('State persisted to %s', STATE_FILE);

  session.disconnect().then(() => {
    logger.info('Baileys session disconnected');
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  }).catch(() => {
    server.close(() => process.exit(1));
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
