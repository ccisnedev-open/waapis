/** Duration of WhatsApp's messaging window in milliseconds (24 hours). */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Metadata for a downloaded media file stored locally by the simulator. */
export interface MediaEntry {
  mediaId: string;
  localPath: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  downloadedAt: number;
}

/** Serializable snapshot of the simulator's in-memory state. */
export interface SimulatorStateSnapshot {
  lastInboundAt: Record<string, number>;
  mediaStore: Record<string, MediaEntry>;
}

/**
 * Holds the simulator's runtime state: 24-hour messaging windows and media registry.
 * Designed to be serialized to JSON for crash-safe persistence (see persistence.ts).
 */
export class SimulatorState {
  private lastInboundAt: Record<string, number> = {};
  private mediaStore: Record<string, MediaEntry> = {};

  /** Records the timestamp of the most recent inbound message from a phone number. */
  recordInbound(phone: string, timestamp: number): void {
    this.lastInboundAt[phone] = timestamp;
  }

  /**
   * Checks whether a free-form (non-template) message can be sent to this phone.
   * Returns true only if the user sent a message within the last 24 hours.
   */
  isWithin24hWindow(phone: string, now: number = Date.now()): boolean {
    const lastTimestamp = this.lastInboundAt[phone];
    if (lastTimestamp === undefined) return false;
    return (now - lastTimestamp) < WINDOW_MS;
  }

  /** Registers a locally-stored media file so it can be served via the REST API. */
  registerMedia(entry: MediaEntry): void {
    this.mediaStore[entry.mediaId] = entry;
  }

  /** Retrieves metadata for a media file by its simulator-generated ID. */
  getMedia(mediaId: string): MediaEntry | undefined {
    return this.mediaStore[mediaId];
  }

  /** Exports the full state as a plain object suitable for JSON.stringify. */
  toJSON(): SimulatorStateSnapshot {
    return {
      lastInboundAt: { ...this.lastInboundAt },
      mediaStore: { ...this.mediaStore },
    };
  }

  /** Reconstructs a SimulatorState from a previously-exported snapshot. */
  static fromJSON(snapshot: SimulatorStateSnapshot): SimulatorState {
    const instance = new SimulatorState();
    instance.lastInboundAt = { ...snapshot.lastInboundAt };
    instance.mediaStore = { ...snapshot.mediaStore };
    return instance;
  }
}
