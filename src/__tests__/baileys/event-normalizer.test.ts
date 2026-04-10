import { describe, it, expect } from 'vitest';
import {
  normalizeInboundMessage,
  normalizeStatusUpdate,
  type InboundMetadata,
} from '../../baileys/event-normalizer.js';

const METADATA: InboundMetadata = {
  displayPhoneNumber: '999000000',
  phoneNumberId: 'sim_pnid_001',
  wabaId: 'sim_waba_001',
};

describe('event-normalizer', () => {
  describe('normalizeInboundMessage — text', () => {
    const textMsg = {
      key: {
        remoteJid: '51999000001@s.whatsapp.net',
        fromMe: false,
        id: 'AABBCCDD1122',
      },
      messageTimestamp: 1710000000,
      pushName: 'Juan Pérez',
      message: {
        conversation: 'Hola, necesito ayuda con mi crédito',
      },
    };

    it('produces the Meta webhook envelope structure', () => {
      const payload = normalizeInboundMessage(textMsg as any, METADATA);

      expect(payload.object).toBe('whatsapp_business_account');
      expect(payload.entry).toHaveLength(1);
      expect(payload.entry[0].id).toBe('sim_waba_001');
      expect(payload.entry[0].changes).toHaveLength(1);
      expect(payload.entry[0].changes[0].field).toBe('messages');
    });

    it('includes metadata with display_phone_number and phone_number_id', () => {
      const payload = normalizeInboundMessage(textMsg as any, METADATA);
      const value = payload.entry[0].changes[0].value;

      expect(value.metadata.display_phone_number).toBe('999000000');
      expect(value.metadata.phone_number_id).toBe('sim_pnid_001');
    });

    it('includes contact info with profile name and wa_id', () => {
      const payload = normalizeInboundMessage(textMsg as any, METADATA);
      const contacts = payload.entry[0].changes[0].value.contacts;

      expect(contacts).toHaveLength(1);
      expect(contacts[0].profile.name).toBe('Juan Pérez');
      expect(contacts[0].wa_id).toBe('51999000001');
    });

    it('includes the text message with correct type and body', () => {
      const payload = normalizeInboundMessage(textMsg as any, METADATA);
      const messages = payload.entry[0].changes[0].value.messages;

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('text');
      expect(messages[0].text!.body).toBe('Hola, necesito ayuda con mi crédito');
      expect(messages[0].from).toBe('51999000001');
    });

    it('generates a wamid.sim_ prefixed message id', () => {
      const payload = normalizeInboundMessage(textMsg as any, METADATA);
      const messages = payload.entry[0].changes[0].value.messages;

      expect(messages[0].id).toMatch(/^wamid\.sim_/);
    });
  });

  describe('normalizeInboundMessage — image', () => {
    const imageMsg = {
      key: {
        remoteJid: '51999000002@s.whatsapp.net',
        fromMe: false,
        id: 'IMG001',
      },
      messageTimestamp: 1710000100,
      pushName: 'María',
      message: {
        imageMessage: {
          caption: 'Mi voucher de pago',
          mimetype: 'image/jpeg',
          fileSha256: Buffer.from('abc123'),
        },
      },
    };

    it('normalizes image messages with media_id and caption', () => {
      const payload = normalizeInboundMessage(imageMsg as any, METADATA, 'sim_media_img001');
      const msg = payload.entry[0].changes[0].value.messages[0];

      expect(msg.type).toBe('image');
      expect(msg.image).toBeDefined();
      expect(msg.image!.id).toBe('sim_media_img001');
      expect(msg.image!.mime_type).toBe('image/jpeg');
      expect(msg.image!.caption).toBe('Mi voucher de pago');
    });
  });

  describe('normalizeInboundMessage — audio', () => {
    const audioMsg = {
      key: {
        remoteJid: '51999000003@s.whatsapp.net',
        fromMe: false,
        id: 'AUD001',
      },
      messageTimestamp: 1710000200,
      pushName: 'Carlos',
      message: {
        audioMessage: {
          mimetype: 'audio/ogg; codecs=opus',
          fileSha256: Buffer.from('def456'),
        },
      },
    };

    it('normalizes audio messages', () => {
      const payload = normalizeInboundMessage(audioMsg as any, METADATA, 'sim_media_aud001');
      const msg = payload.entry[0].changes[0].value.messages[0];

      expect(msg.type).toBe('audio');
      expect(msg.audio!.id).toBe('sim_media_aud001');
      expect(msg.audio!.mime_type).toBe('audio/ogg; codecs=opus');
    });
  });

  describe('normalizeInboundMessage — document', () => {
    const docMsg = {
      key: {
        remoteJid: '51999000004@s.whatsapp.net',
        fromMe: false,
        id: 'DOC001',
      },
      messageTimestamp: 1710000300,
      pushName: 'Ana',
      message: {
        documentMessage: {
          mimetype: 'application/pdf',
          fileName: 'contrato.pdf',
          fileSha256: Buffer.from('ghi789'),
        },
      },
    };

    it('normalizes document messages with filename', () => {
      const payload = normalizeInboundMessage(docMsg as any, METADATA, 'sim_media_doc001');
      const msg = payload.entry[0].changes[0].value.messages[0];

      expect(msg.type).toBe('document');
      expect(msg.document!.id).toBe('sim_media_doc001');
      expect(msg.document!.filename).toBe('contrato.pdf');
    });
  });

  describe('normalizeStatusUpdate', () => {
    it('produces the Meta status webhook structure', () => {
      const payload = normalizeStatusUpdate(
        { messageId: 'wamid.sim_abc', recipientId: '51999000001', status: 'delivered', timestamp: 1710000001 },
        METADATA,
      );

      expect(payload.object).toBe('whatsapp_business_account');
      const statuses = payload.entry[0].changes[0].value.statuses;
      expect(statuses).toHaveLength(1);
      expect(statuses[0].id).toBe('wamid.sim_abc');
      expect(statuses[0].status).toBe('delivered');
      expect(statuses[0].recipient_id).toBe('51999000001');
    });

    it('includes pricing and conversation fields', () => {
      const payload = normalizeStatusUpdate(
        { messageId: 'wamid.sim_xyz', recipientId: '51999000002', status: 'read', timestamp: 1710000002 },
        METADATA,
      );

      const status = payload.entry[0].changes[0].value.statuses[0];
      expect(status.pricing.billable).toBe(false);
      expect(status.conversation).toBeDefined();
    });
  });

  describe('normalizeInboundMessage — resolvedFrom override', () => {
    const lidMsg = {
      key: {
        remoteJid: '48915483205670@lid',
        fromMe: false,
        id: 'LID_MSG_001',
      },
      messageTimestamp: 1710000000,
      pushName: 'Contacto LID',
      message: { conversation: 'Hola desde LID' },
    };

    it('uses resolvedFrom instead of remoteJid when provided', () => {
      const payload = normalizeInboundMessage(lidMsg as any, METADATA, undefined, '51903429745');
      const value = payload.entry[0].changes[0].value;

      expect(value.contacts[0].wa_id).toBe('51903429745');
      expect(value.messages[0].from).toBe('51903429745');
    });

    it('falls back to remoteJid extraction when resolvedFrom is undefined', () => {
      const phoneMsg = {
        key: { remoteJid: '51999000001@s.whatsapp.net', fromMe: false, id: 'PN_MSG_001' },
        messageTimestamp: 1710000000,
        pushName: 'Contacto PN',
        message: { conversation: 'Hola normal' },
      };

      const payload = normalizeInboundMessage(phoneMsg as any, METADATA);
      const value = payload.entry[0].changes[0].value;

      expect(value.contacts[0].wa_id).toBe('51999000001');
      expect(value.messages[0].from).toBe('51999000001');
    });
  });
});
