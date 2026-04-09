import { Router } from 'express';
import { existsSync, createReadStream } from 'node:fs';
import { createAuthTokenMiddleware } from '../middleware/auth-token.js';
import type { SimulatorState } from '../state/simulator-state.js';

/**
 * Media routes — serves metadata and binary downloads for media received by the simulator.
 *
 * GET /:mediaId — Returns metadata + download URL (§4.3.1 of spec)
 * GET /media/download/:mediaId — Returns the binary file (§4.3.2 of spec)
 */
export function createMediaRouter(accessToken: string, state: SimulatorState): Router {
  const router = Router();
  const authMiddleware = createAuthTokenMiddleware(accessToken);

  // Binary download — must be registered BEFORE the :mediaId catch-all
  router.get('/media/download/:mediaId', authMiddleware, (req, res) => {
    const entry = state.getMedia(req.params.mediaId as string);

    if (!entry || !existsSync(entry.localPath)) {
      res.status(404).json({ error: { message: 'Media not found', code: 404 } });
      return;
    }

    res.setHeader('Content-Type', entry.mimeType);
    res.setHeader('Content-Length', entry.fileSize);
    createReadStream(entry.localPath).pipe(res);
  });

  // Metadata — returns the download URL + file info
  router.get('/:mediaId', authMiddleware, (req, res) => {
    const entry = state.getMedia(req.params.mediaId as string);

    if (!entry) {
      res.status(404).json({ error: { message: 'Media not found', code: 404 } });
      return;
    }

    // Build download URL relative to the current host
    const protocol = req.protocol;
    const host = req.get('host');
    const downloadUrl = `${protocol}://${host}/media/download/${entry.mediaId}`;

    res.json({
      url: downloadUrl,
      mime_type: entry.mimeType,
      sha256: entry.sha256,
      file_size: entry.fileSize,
      id: entry.mediaId,
      messaging_product: 'whatsapp',
    });
  });

  return router;
}
