import express from 'express';
import type { SimulatorConfig } from './config.js';
import type { SimulatorState } from './state/simulator-state.js';
import type { DashboardSession } from './routes/dashboard.route.js';
import { createHealthRouter } from './routes/health.route.js';
import { createWebhookRouter } from './routes/webhook.route.js';
import { createTemplatesRouter } from './routes/templates.route.js';
import { createMessagesRouter } from './routes/messages.route.js';
import { createMediaRouter } from './routes/media.route.js';
import { createDashboardRouter } from './routes/dashboard.route.js';

/**
 * Creates and configures the Express application with all routes.
 * Separated from the server start so the app can be tested without listening on a port.
 */
export function createApp(
  config: SimulatorConfig,
  state: SimulatorState,
  session: DashboardSession & { asStatusProvider: () => any; asMessageSender: () => any },
): express.Application {
  const app = express();

  app.use(express.json());

  // ── Routes (order matters: specific paths before parameterized catch-alls) ──
  app.use('/health', createHealthRouter(session.asStatusProvider()));
  if (config.verifyToken) {
    app.use('/webhook', createWebhookRouter(config.verifyToken));
  }
  app.use('/', createDashboardRouter(session));
  app.use('/', createTemplatesRouter(config.accessToken));
  app.use('/', createMessagesRouter(config.accessToken, state, session.asMessageSender()));
  // Media routes LAST — /:mediaId is a catch-all parameter
  app.use('/', createMediaRouter(config.accessToken, state));

  return app;
}
