import test from 'node:test';
import assert from 'node:assert/strict';

const { transcribeAudio, downloadAttachment } = await import('../src/voice.js');

function stubFetch(routes) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    for (const [match, handler] of routes) {
      if (String(url).includes(match)) return handler(url, opts);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return () => { globalThis.fetch = realFetch; };
}

test('downloadAttachment returns bytes and content type', async () => {
  const restore = stubFetch([
    ['cdn/audio', async () => ({
      ok: true,
      headers: { get: () => 'audio/aac' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })],
  ]);
  try {
    const { buffer, contentType } = await downloadAttachment('https://cdn/audio.mp4');
    assert.equal(contentType, 'audio/aac');
    assert.equal(buffer.length, 3);
  } finally {
    restore();
  }
});

test('transcribeAudio posts to Deepgram and returns the transcript', async () => {
  const seen = {};
  const restore = stubFetch([
    ['api.deepgram.com', async (url, opts) => {
      seen.url = url;
      seen.auth = opts.headers.Authorization;
      seen.type = opts.headers['content-type'];
      return {
        ok: true,
        json: async () => ({
          results: { channels: [{ alternatives: [{ transcript: 'hello bot', confidence: 0.98 }] }] },
        }),
      };
    }],
  ]);
  try {
    const { transcript, confidence } = await transcribeAudio({
      buffer: Buffer.from([1, 2, 3]),
      contentType: 'audio/aac',
      apiKey: 'KEY',
      model: 'nova-3',
      language: 'en',
    });
    assert.equal(transcript, 'hello bot');
    assert.equal(confidence, 0.98);
    assert.match(seen.url, /model=nova-3/);
    assert.match(seen.url, /language=en/);
    assert.equal(seen.auth, 'Token KEY');
  } finally {
    restore();
  }
});

test('transcribeAudio throws on Deepgram errors and empty results', async () => {
  const restore = stubFetch([
    ['api.deepgram.com', async () => ({ ok: false, status: 401, json: async () => ({}) })],
  ]);
  try {
    await assert.rejects(
      transcribeAudio({ buffer: Buffer.alloc(1), contentType: 'x', apiKey: 'K', model: 'm', language: 'en' }),
      /Deepgram → 401/,
    );
  } finally {
    restore();
  }
});
