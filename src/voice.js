import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './config.js';

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';

/**
 * Voice notes → Deepgram Nova-3 (English) → transcript.
 * Images are downloaded and kept on disk instead (vision piping is future work).
 */

export function deepgramConfig() {
  const apiKey = process.env.DEEPGRAM_API_KEY?.trim() || null;
  if (!apiKey) return null;
  return {
    apiKey,
    model: process.env.DEEPGRAM_MODEL?.trim() || 'nova-3',
    language: process.env.DEEPGRAM_LANGUAGE?.trim() || 'en',
  };
}

export async function downloadAttachment(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`attachment download → ${res.status}`);
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('attachment download returned no bytes');
  return { buffer, contentType };
}

export async function transcribeAudio({ buffer, contentType, apiKey, model, language }) {
  const params = new URLSearchParams({ model, language, smart_format: 'true', filler_words: 'false' });
  const res = await fetch(`${DEEPGRAM_URL}?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'content-type': contentType },
    body: buffer,
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Deepgram → ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const transcript = String(
    data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '',
  ).trim();
  const confidence = data?.results?.channels?.[0]?.alternatives?.[0]?.confidence ?? null;
  if (!transcript) throw new Error('Deepgram returned no transcript');
  return { transcript, confidence };
}

/** Transcribes the first audio attachment; throws when unusable. */
export async function transcribeVoiceAttachment(attachment, config = deepgramConfig()) {
  if (!config) throw new Error('DEEPGRAM_API_KEY is not set — add it to .env');
  if (!attachment?.url) throw new Error('voice attachment has no download URL');
  const { buffer, contentType } = await downloadAttachment(attachment.url);
  return transcribeAudio({ buffer, contentType, ...config });
}

export function mediaDir() {
  const dir = path.join(homeDir(), 'media');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Saves an image attachment to ~/media and returns the saved path. */
export async function saveImageAttachment(attachment, mid = '') {
  const { buffer, contentType } = await downloadAttachment(attachment.url);
  const ext = (contentType.split('/')[1] ?? 'bin').split(/[;+]/)[0].slice(0, 8) || 'bin';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `img-${stamp}${mid ? `-${String(mid).slice(-6)}` : ''}.${ext}`;
  const file = path.join(mediaDir(), name);
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  return { file, bytes: buffer.length };
}
