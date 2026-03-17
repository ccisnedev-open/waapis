import { describe, it, expect, beforeEach } from 'vitest';
import { SimulatorState } from '../../state/simulator-state.js';
import type { MediaEntry } from '../../state/simulator-state.js';

describe('SimulatorState', () => {
  let state: SimulatorState;

  beforeEach(() => {
    state = new SimulatorState();
  });

  describe('inbound window tracking', () => {
    it('records an inbound timestamp for a phone number', () => {
      const now = Date.now();
      state.recordInbound('51999000001', now);

      expect(state.isWithin24hWindow('51999000001', now + 1000)).toBe(true);
    });

    it('returns false for a phone with no inbound history', () => {
      expect(state.isWithin24hWindow('51999000001')).toBe(false);
    });

    it('returns false when 24h have elapsed since last inbound', () => {
      const past = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
      state.recordInbound('51999000001', past);

      expect(state.isWithin24hWindow('51999000001')).toBe(false);
    });

    it('returns true when exactly within the 24h boundary', () => {
      const past = Date.now() - (23 * 60 * 60 * 1000); // 23 hours ago
      state.recordInbound('51999000001', past);

      expect(state.isWithin24hWindow('51999000001')).toBe(true);
    });

    it('overwrites previous timestamp on new inbound', () => {
      const old = Date.now() - (25 * 60 * 60 * 1000);
      const recent = Date.now();

      state.recordInbound('51999000001', old);
      expect(state.isWithin24hWindow('51999000001')).toBe(false);

      state.recordInbound('51999000001', recent);
      expect(state.isWithin24hWindow('51999000001')).toBe(true);
    });
  });

  describe('media store', () => {
    const sampleMedia: MediaEntry = {
      mediaId: 'sim_media_001',
      localPath: './media/sim_media_001.jpg',
      mimeType: 'image/jpeg',
      fileSize: 204800,
      sha256: 'abc123def456',
      downloadedAt: Date.now(),
    };

    it('registers and retrieves a media entry', () => {
      state.registerMedia(sampleMedia);

      const retrieved = state.getMedia('sim_media_001');
      expect(retrieved).toEqual(sampleMedia);
    });

    it('returns undefined for unknown media id', () => {
      expect(state.getMedia('nonexistent')).toBeUndefined();
    });
  });

  describe('serialization', () => {
    it('exports state as a plain object for JSON persistence', () => {
      state.recordInbound('51999000001', 1710000000000);
      state.registerMedia({
        mediaId: 'sim_media_001',
        localPath: './media/sim_media_001.jpg',
        mimeType: 'image/jpeg',
        fileSize: 204800,
        sha256: 'abc123',
        downloadedAt: 1710000000000,
      });

      const snapshot = state.toJSON();

      expect(snapshot.lastInboundAt).toEqual({ '51999000001': 1710000000000 });
      expect(snapshot.mediaStore).toHaveProperty('sim_media_001');
    });

    it('restores state from a previously exported snapshot', () => {
      const snapshot = {
        lastInboundAt: { '51999000001': Date.now() },
        mediaStore: {
          sim_media_001: {
            mediaId: 'sim_media_001',
            localPath: './media/sim_media_001.jpg',
            mimeType: 'image/jpeg',
            fileSize: 204800,
            sha256: 'abc123',
            downloadedAt: Date.now(),
          },
        },
      };

      const restored = SimulatorState.fromJSON(snapshot);

      expect(restored.isWithin24hWindow('51999000001')).toBe(true);
      expect(restored.getMedia('sim_media_001')).toBeDefined();
    });
  });
});
