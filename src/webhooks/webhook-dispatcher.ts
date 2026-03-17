import { createHmac } from 'node:crypto';

/**
 * Computes the HMAC-SHA256 signature for a webhook payload, formatted
 * exactly as Meta does: "sha256={hex_digest}".
 */
export function computeHmacSignature(rawBody: string, appSecret: string): string {
  const digest = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

/**
 * Dispatches a webhook POST to the configured callback URL.
 * Includes X-Hub-Signature-256 for authenticity verification (ADR-S04).
 * Failures are logged but never propagated — webhook delivery is best-effort.
 */
export async function dispatchWebhook(
  payload: unknown,
  callbackUrl: string,
  appSecret: string,
): Promise<void> {
  const rawBody = JSON.stringify(payload);
  const signature = computeHmacSignature(rawBody, appSecret);

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signature,
        },
        body: rawBody,
      });

      if (response.ok) return;

      // Non-2xx response — retry on server errors, give up on client errors
      if (response.status >= 400 && response.status < 500) return;

    } catch {
      // Network error — retry with backoff
      if (attempt < maxAttempts) {
        const backoffMs = Math.pow(2, attempt) * 500;
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }
}
