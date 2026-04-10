import { randomUUID } from 'node:crypto';

// ── Types for the normalized Meta-compatible webhook payload ──

export interface InboundMetadata {
  displayPhoneNumber: string;
  phoneNumberId: string;
  wabaId: string;
}

interface MetaContact {
  profile: { name: string };
  wa_id: string;
}

interface MetaMediaRef {
  id: string;
  mime_type: string;
  sha256?: string;
  caption?: string;
  filename?: string;
}

interface MetaMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: MetaMediaRef;
  video?: MetaMediaRef;
  audio?: MetaMediaRef;
  document?: MetaMediaRef;
  location?: { latitude: number; longitude: number };
}

interface MetaStatusEntry {
  id: string;
  recipient_id: string;
  status: string;
  timestamp: string;
  conversation: { id: string; expiration_timestamp: string; origin: { type: string } };
  pricing: { billable: boolean; pricing_model: string; category: string };
}

interface MetaWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts: MetaContact[];
        messages: MetaMessage[];
        statuses: MetaStatusEntry[];
      };
      field: string;
    }>;
  }>;
}

export interface StatusUpdateInput {
  messageId: string;
  recipientId: string;
  status: 'delivered' | 'read';
  timestamp: number;
}

// ── Helpers ──

/** Extracts the raw phone number from a Baileys JID (strips @s.whatsapp.net and @lid). */
function phoneFromJid(jid: string): string {
  return jid.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '');
}

/** Generates a simulator message ID in Meta format: wamid.sim_{uuid}. */
function generateSimWamid(): string {
  return `wamid.sim_${randomUUID()}`;
}

/**
 * Determines the message type and extracts the appropriate content
 * from a Baileys WAMessage.message object.
 */
function extractMessageContent(
  message: Record<string, any>,
  mediaId?: string,
): Pick<MetaMessage, 'type' | 'text' | 'image' | 'video' | 'audio' | 'document' | 'location'> {
  // Text (conversation or extendedTextMessage)
  if (message.conversation !== undefined || message.extendedTextMessage) {
    const body = message.conversation ?? message.extendedTextMessage?.text ?? '';
    return { type: 'text', text: { body } };
  }

  // Image
  if (message.imageMessage) {
    return {
      type: 'image',
      image: {
        id: mediaId ?? '',
        mime_type: message.imageMessage.mimetype ?? 'image/jpeg',
        sha256: message.imageMessage.fileSha256?.toString('base64'),
        caption: message.imageMessage.caption,
      },
    };
  }

  // Video
  if (message.videoMessage) {
    return {
      type: 'video',
      video: {
        id: mediaId ?? '',
        mime_type: message.videoMessage.mimetype ?? 'video/mp4',
        sha256: message.videoMessage.fileSha256?.toString('base64'),
        caption: message.videoMessage.caption,
      },
    };
  }

  // Audio
  if (message.audioMessage) {
    return {
      type: 'audio',
      audio: {
        id: mediaId ?? '',
        mime_type: message.audioMessage.mimetype ?? 'audio/ogg; codecs=opus',
        sha256: message.audioMessage.fileSha256?.toString('base64'),
      },
    };
  }

  // Document
  if (message.documentMessage) {
    return {
      type: 'document',
      document: {
        id: mediaId ?? '',
        mime_type: message.documentMessage.mimetype ?? 'application/pdf',
        sha256: message.documentMessage.fileSha256?.toString('base64'),
        filename: message.documentMessage.fileName,
      },
    };
  }

  // Location
  if (message.locationMessage) {
    return {
      type: 'location',
      location: {
        latitude: message.locationMessage.degreesLatitude,
        longitude: message.locationMessage.degreesLongitude,
      },
    };
  }

  // Fallback — treat as text with empty body
  return { type: 'text', text: { body: '' } };
}

// ── Public API ──

/**
 * Transforms a Baileys WAMessage into the exact Meta webhook payload structure (§5.1 of spec).
 * This is the core normalization that makes consumers unable to distinguish
 * between the simulator and Meta's real API.
 */
export function normalizeInboundMessage(
  waMessage: any,
  metadata: InboundMetadata,
  mediaId?: string,
  resolvedFrom?: string,
): MetaWebhookPayload {
  const from = resolvedFrom ?? phoneFromJid(waMessage.key.remoteJid);
  const timestamp = String(
    typeof waMessage.messageTimestamp === 'number'
      ? waMessage.messageTimestamp
      : Math.floor(Date.now() / 1000),
  );
  const profileName = waMessage.pushName ?? 'Unknown';
  const content = extractMessageContent(waMessage.message ?? {}, mediaId);

  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: metadata.wabaId,
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: metadata.displayPhoneNumber,
                phone_number_id: metadata.phoneNumberId,
              },
              contacts: [
                {
                  profile: { name: profileName },
                  wa_id: from,
                },
              ],
              messages: [
                {
                  id: generateSimWamid(),
                  from,
                  timestamp,
                  ...content,
                },
              ],
              statuses: [],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

/**
 * Produces a Meta-compatible status update webhook payload (§5.2 of spec).
 * Dispatched when Baileys confirms message delivery or read receipt.
 */
export function normalizeStatusUpdate(
  input: StatusUpdateInput,
  metadata: InboundMetadata,
): MetaWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: metadata.wabaId,
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: metadata.displayPhoneNumber,
                phone_number_id: metadata.phoneNumberId,
              },
              contacts: [],
              messages: [],
              statuses: [
                {
                  id: input.messageId,
                  recipient_id: input.recipientId,
                  status: input.status,
                  timestamp: String(input.timestamp),
                  conversation: {
                    id: `sim_conv_${randomUUID()}`,
                    expiration_timestamp: String(input.timestamp + 86400),
                    origin: { type: 'service' },
                  },
                  pricing: {
                    billable: false,
                    pricing_model: 'CBP',
                    category: 'service',
                  },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}
