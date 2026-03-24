import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import type { SessionStatusProvider } from './health.route.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Contract for dashboard session operations.
 * Extends SessionStatusProvider with QR, disconnect, and connect.
 */
export interface DashboardSession extends SessionStatusProvider {
  currentQR(): string | undefined;
  disconnect(clearAuth?: boolean): Promise<void>;
  connect(): Promise<void>;
}

/**
 * Dashboard routes:
 *   GET  /dashboard              → serves the dashboard SPA HTML
 *   GET  /api/session/status     → JSON with session state (connected/disconnected/connecting + QR)
 *   POST /api/session/logout     → disconnects and clears credentials
 *   POST /api/session/reconnect  → reconnects the session
 */
export function createDashboardRouter(session: DashboardSession): Router {
  const router = Router();

  // ── Dashboard HTML ──
  router.get('/dashboard', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dashboard', 'index.html'));
  });

  // ── Session status API ──
  router.get('/api/session/status', async (_req, res) => {
    if (session.isConnected()) {
      res.json({ status: 'connected', phone: session.phoneNumber() });
      return;
    }

    const qr = session.currentQR();
    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 260 });
      res.json({ status: 'connecting', qr: qr, qrDataUrl });
      return;
    }

    res.json({ status: 'disconnected' });
  });

  // ── Logout ──
  router.post('/api/session/logout', async (_req, res) => {
    await session.disconnect(true);
    res.json({ ok: true });
  });

  // ── Reconnect ──
  router.post('/api/session/reconnect', async (_req, res) => {
    await session.disconnect(true);
    await session.connect();
    res.json({ ok: true });
  });

  return router;
}
