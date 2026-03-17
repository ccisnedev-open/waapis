import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { computeHmacSignature } from '../../webhooks/webhook-dispatcher.js';

describe('webhook-dispatcher', () => {
  describe('computeHmacSignature', () => {
    it('produces a valid HMAC-SHA256 hex signature', () => {
      const payload = JSON.stringify({ test: 'data' });
      const secret = 'test_secret';

      const signature = computeHmacSignature(payload, secret);

      // Manually compute expected
      const expected = createHmac('sha256', secret).update(payload).digest('hex');
      expect(signature).toBe(`sha256=${expected}`);
    });

    it('produces different signatures for different payloads', () => {
      const secret = 'test_secret';
      const sig1 = computeHmacSignature('payload_a', secret);
      const sig2 = computeHmacSignature('payload_b', secret);

      expect(sig1).not.toBe(sig2);
    });

    it('produces different signatures for different secrets', () => {
      const payload = 'same_payload';
      const sig1 = computeHmacSignature(payload, 'secret_a');
      const sig2 = computeHmacSignature(payload, 'secret_b');

      expect(sig1).not.toBe(sig2);
    });
  });

  describe('dispatchWebhook', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('sends POST with correct headers and body', async () => {
      const { dispatchWebhook } = await import('../../webhooks/webhook-dispatcher.js');

      let capturedUrl: string | undefined;
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = url as string;
        capturedInit = init;
        return new Response('ok', { status: 200 });
      }) as typeof fetch;

      const payload = { object: 'whatsapp_business_account', entry: [] };

      await dispatchWebhook(payload, 'http://localhost:8080/webhooks/whatsapp', 'my_secret');

      expect(capturedUrl).toBe('http://localhost:8080/webhooks/whatsapp');
      expect(capturedInit?.method).toBe('POST');
      expect(capturedInit?.headers).toHaveProperty('Content-Type', 'application/json');
      expect(capturedInit?.headers).toHaveProperty('X-Hub-Signature-256');

      // Verify the body is the JSON-serialized payload
      const body = JSON.parse(capturedInit?.body as string);
      expect(body.object).toBe('whatsapp_business_account');
    });

    it('includes correct HMAC signature in X-Hub-Signature-256 header', async () => {
      const { dispatchWebhook, computeHmacSignature } = await import('../../webhooks/webhook-dispatcher.js');

      let capturedHeaders: Record<string, string> = {};

      globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response('ok', { status: 200 });
      }) as typeof fetch;

      const payload = { test: 'value' };
      const secret = 'hmac_secret';
      await dispatchWebhook(payload, 'http://example.com/hook', secret);

      const rawBody = JSON.stringify(payload);
      const expectedSig = computeHmacSignature(rawBody, secret);
      expect(capturedHeaders['X-Hub-Signature-256']).toBe(expectedSig);
    });

    it('does not throw when the callback URL is unreachable', async () => {
      const { dispatchWebhook } = await import('../../webhooks/webhook-dispatcher.js');

      globalThis.fetch = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch;

      // Should not propagate the error — webhook failures are non-fatal
      await expect(
        dispatchWebhook({ data: 1 }, 'http://unreachable:9999/hook', 'secret')
      ).resolves.not.toThrow();
    });
  });
});
