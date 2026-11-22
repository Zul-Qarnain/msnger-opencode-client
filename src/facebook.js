import crypto from 'node:crypto';

const GRAPH_VERSION = process.env.FB_GRAPH_VERSION?.trim() || 'v21.0';
const graphBase = () => `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Direct Meta Messenger integration (no OnlyOrders).
 * Incoming webhooks arrive as {object:'page', entry:[{id, messaging:[...]}]};
 * outgoing replies go to POST /me/messages with the Page access token.
 */

/** GET /webhook verification: returns hub.challenge when the token matches. */
export function verifyWebhook(query, verifyToken) {
  const mode = query?.['hub.mode'] ?? query?.hub_mode;
  const token = query?.['hub.verify_token'] ?? query?.hub_verify_token;
  const challenge = query?.['hub.challenge'] ?? query?.hub_challenge;
  if (mode === 'subscribe' && token && token === verifyToken) return String(challenge ?? '');
  return null;
}

/** Validates X-Hub-Signature-256. Skips when no secret is configured. */
export function verifySignature(rawBody, appSecret, signatureHeader) {
  if (!appSecret) return true;
  if (!signatureHeader) return false;
  const [algo, hash] = String(signatureHeader).split('=', 2);
  if (algo !== 'sha256' || !hash) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody ?? '').digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Normalizes a Meta webhook body into [{pageId, senderId, text, mid}].
 * Handles BOTH delivery shapes:
 *  - Messenger Platform: entry[].messaging[] (message.text / postback.payload)
 *  - Page field subscriptions: entry[].changes[] with field 'messages' etc.,
 *    value {sender, message:{mid,text,attachments}, postback:{payload}}
 * Skips echoes of our own replies and non-message events (read/delivery).
 */
export function parseMessengerEvents(body) {
  if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return [];
  const out = [];
  for (const entry of body.entry) {
    const pageId = String(entry?.id ?? '');
    for (const item of entry?.messaging ?? []) {
      if (item?.message?.is_echo) continue;
      const senderId = String(item?.sender?.id ?? '');
      if (!senderId) continue;
      const attachments = (item?.message?.attachments ?? [])
        .map((a) => ({ type: String(a?.type ?? 'file'), url: String(a?.payload?.url ?? '') }));
      let text = '';
      if (typeof item?.message?.text === 'string') text = item.message.text;
      else if (typeof item?.postback?.payload === 'string') text = item.postback.payload;
      else if (attachments.length) text = `[attachment:${attachments.map((a) => a.type).join(',')}]`;
      else continue;
      out.push({
        pageId,
        senderId,
        text: String(text),
        mid: String(item?.message?.mid ?? item?.postback?.mid ?? ''),
        attachments,
      });
    }
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const message = value?.message ?? {};
      if (message.is_echo) continue;
      const senderId = String(value?.sender?.id ?? '');
      if (!senderId) continue;
      const attachments = (message?.attachments ?? [])
        .map((a) => ({ type: String(a?.type ?? 'file'), url: String(a?.payload?.url ?? '') }));
      let text = '';
      if (typeof message?.text === 'string') text = message.text;
      else if (typeof value?.postback?.payload === 'string') text = value.postback.payload;
      else if (attachments.length) {
        const kinds = attachments.map((a) => a.type).join(',');
        text = `[attachment:${kinds}]`;
      } else continue;
      out.push({
        pageId,
        senderId,
        text: String(text),
        mid: String(message?.mid ?? ''),
        attachments,
      });
    }
  }
  return out;
}

export function splitText(text, max = 1500) {
  if (!text) return ['(no output)'];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/** Sends one Messenger reply via the Page token. Splits long answers. */
export async function sendMessage({ pageToken, recipientId, text }) {
  if (!pageToken) throw new Error('FB_PAGE_TOKEN is not set');
  const chunks = splitText(String(text ?? ''));
  for (const chunk of chunks) {
    const res = await fetch(`${graphBase()}/me/messages?access_token=${encodeURIComponent(pageToken)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text: chunk } }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Graph SendMessage → ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    }
  }
  return chunks.length;
}

/** Sends one image reply via the Page token. */
export async function sendImage({ pageToken, recipientId, imageUrl }) {
  if (!pageToken) throw new Error('FB_PAGE_TOKEN is not set');
  if (!/^https?:\/\//i.test(imageUrl ?? '')) throw new Error('image URL must be http(s)');
  const res = await fetch(`${graphBase()}/me/messages?access_token=${encodeURIComponent(pageToken)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: false } } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Graph SendImage → ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data?.message_id ?? null;
}
