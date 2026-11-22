import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';

const {
  parseMessengerEvents,
  sendMessage,
  splitText,
  verifySignature,
  verifyWebhook,
} = await import('../src/facebook.js');
const { createHttpServer } = await import('../src/server.js');
const { tunnelUnitContent } = await import('../src/systemd.js');

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

test('verifyWebhook returns the challenge only on token match', () => {
  const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'tok123', 'hub.challenge': 'CHAL' };
  assert.equal(verifyWebhook(q, 'tok123'), 'CHAL');
  assert.equal(verifyWebhook(q, 'wrong'), null);
  assert.equal(verifyWebhook({ 'hub.mode': 'subscribe' }, 'tok123'), null);
});

test('parseMessengerEvents normalizes text/postback and skips echoes', () => {
  const body = {
    object: 'page',
    entry: [{
      id: 'PAGE1',
      messaging: [
        { sender: { id: 'U1' }, message: { mid: 'm1', text: 'hello' } },
        { sender: { id: 'U2' }, postback: { payload: '/session' } },
        { sender: { id: 'U3' }, message: { mid: 'm3', text: 'echo', is_echo: true } },
        { sender: { id: 'U4' }, read: { watermark: 1 } },
      ],
    }],
  };
  assert.deepEqual(parseMessengerEvents(body), [
    { pageId: 'PAGE1', senderId: 'U1', text: 'hello', mid: 'm1', attachments: [] },
    { pageId: 'PAGE1', senderId: 'U2', text: '/session', mid: '', attachments: [] },
  ]);
  assert.deepEqual(parseMessengerEvents({ object: 'user' }), []);
  assert.deepEqual(parseMessengerEvents(null), []);
});

test('parseMessengerEvents handles Page field-subscription (changes[]) format', () => {
  const body = {
    object: 'page',
    entry: [{
      id: 'PAGE1',
      time: 1527459824,
      changes: [
        {
          field: 'messages',
          value: {
            sender: { id: 'U1' },
            recipient: { id: 'PAGE1' },
            timestamp: '1527459824',
            message: { mid: 'm1', text: 'hi page' },
          },
        },
        {
          field: 'messages',
          value: {
            sender: { id: 'U2' },
            message: { mid: 'm2', attachments: [{ type: 'image' }, { type: 'audio' }] },
          },
        },
        {
          field: 'messages',
          value: { sender: { id: 'U3' }, message: { mid: 'm3', text: 'echo', is_echo: true } },
        },
      ],
    }],
  };
  assert.deepEqual(parseMessengerEvents(body), [
    { pageId: 'PAGE1', senderId: 'U1', text: 'hi page', mid: 'm1', attachments: [] },
    {
      pageId: 'PAGE1',
      senderId: 'U2',
      text: '[attachment:image,audio]',
      mid: 'm2',
      attachments: [{ type: 'image', url: '' }, { type: 'audio', url: '' }],
    },
  ]);
});

test('splitText chunks long replies on newlines', () => {
  assert.deepEqual(splitText('', 10), ['(no output)']);
  assert.deepEqual(splitText('short', 10), ['short']);
  const long = `${'a'.repeat(8)}\n${'b'.repeat(8)}`;
  assert.deepEqual(splitText(long, 10), ['aaaaaaaa', 'bbbbbbbb']);
});

test('verifySignature accepts HMAC, rejects forgeries, skips without secret', () => {
  assert.equal(verifySignature('body', null, null), true);
  const mac = `sha256=${crypto.createHmac('sha256', 's3').update('body').digest('hex')}`;
  assert.equal(verifySignature('body', 's3', mac), true);
  assert.equal(verifySignature('body', 's3', 'sha256=dead'), false);
  assert.equal(verifySignature('body', 's3', null), false);
});

test('sendMessage posts chunks to the Graph API', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({}) };
  };
  try {
    await sendMessage({ pageToken: 'TOK', recipientId: 'U9', text: 'hi' });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /graph\.facebook\.com\/v21\.0\/me\/messages/);
    assert.match(calls[0].url, /access_token=TOK/);
    assert.equal(calls[0].body.recipient.id, 'U9');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('named tunnel unit uses --config and no --url', () => {
  const unit = tunnelUnitContent({
    user: 'admin',
    binary: '/usr/local/bin/cloudflared',
    port: 8788,
    logPath: '/tmp/t.log',
    tunnelConfigFile: '/home/admin/.config/msgctrl/forest.yml',
  });
  assert.match(unit, /tunnel --no-autoupdate --config \/home\/admin\/.config\/msgctrl\/forest\.yml run/);
  assert.doesNotMatch(unit, /--url/);
  assert.match(unit, /Restart=always/);
});

test('server verifies Meta webhook and dispatches page events to the handler', async () => {
  const port = await freePort();
  const prompted = [];
  const seen = [];
  const client = {
    session: { prompt: async ({ text }) => { prompted.push(text); } },
    message: { list: async () => ({ data: [] }) },
    permission: { request: { list: async () => ({ data: [] }) } },
  };
  const server = createHttpServer({
    serviceId: null,
    port,
    client,
    defaultSessionId: 's1',
    facebook: { pageToken: 'TOK', verifyToken: 'tok123', appSecret: null, pageId: 'PAGE1' },
    onWebhookEvent: (event) => seen.push(event),
    log: () => {},
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/webhook?hub.mode=subscribe&hub.verify_token=tok123&hub.challenge=CHAL`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'CHAL');

    const bad = await fetch(`http://127.0.0.1:${port}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=CHAL`);
    assert.equal(bad.status, 403);

    const post = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        object: 'page',
        entry: [{ id: 'PAGE1', messaging: [{ sender: { id: 'U1' }, message: { mid: 'm1', text: 'hi bot' } }] }],
      }),
    });
    assert.equal(post.status, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen[0]?.payload?.text, 'hi bot');
    assert.equal(seen[0]?.customerInfo?.id, 'U1');
    assert.deepEqual(prompted, ['hi bot']);
  } finally {
    server.close();
  }
});

test('sendImage posts an image attachment', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ message_id: 'mid1' }) };
  };
  const { sendImage } = await import('../src/facebook.js');
  try {
    const id = await sendImage({ pageToken: 'TOK', recipientId: 'U1', imageUrl: 'https://cdn/x.png' });
    assert.equal(id, 'mid1');
    assert.equal(calls[0].body.message.attachment.type, 'image');
    assert.equal(calls[0].body.message.attachment.payload.url, 'https://cdn/x.png');
  } finally {
    globalThis.fetch = realFetch;
  }
});
