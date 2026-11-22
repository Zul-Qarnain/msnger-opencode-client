import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createCommandHandler } from './commands.js';
import { connect, createSession, listModels, pickRandomModel } from './opencode.js';
import {
  registerWebhook,
  sendMessage,
  updateWebhook,
} from './onlyorders.js';
import {
  parseMessengerEvents,
  sendImage as sendFbImage,
  sendMessage as sendFbMessage,
  verifySignature,
  verifyWebhook,
} from './facebook.js';
import { startTunnel, watchTunnelUrl } from './tunnel.js';
import { homeDir, loadDb, loadState, logState, saveDb, saveState } from './config.js';

const PORT = Number(process.env.PORT ?? 8788);
const DEFAULT_DIRECTORY = process.env.DEFAULT_DIRECTORY ?? process.cwd();

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    req.rawBody = text;
  } catch { /* non-extensible request in tests */ }
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

/** Owner-only mode: sender IDs allowed to use the bot (null = everyone). */
export function ownerIds() {
  const fromEnv = (process.env.OWNER_PSIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const db = loadDb();
  const fromDb = Array.isArray(db.ownerIds) ? db.ownerIds.map(String) : [];
  const all = [...fromEnv, ...fromDb].filter(Boolean);
  return all.length ? all : null;
}
export function loadDotenv() {
  try {
    const file = path.join(homeDir(), '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) process.env[key] = value;
    }
  } catch { /* .env is optional */ }
}

/** Direct-Facebook config from env (preferred) or db.json. Null = OnlyOrders mode. */
export function facebookConfig() {
  const db = loadDb();
  const pageToken = process.env.FB_PAGE_TOKEN?.trim() || db.fbPageToken || null;
  if (!pageToken) return null;
  return {
    pageToken,
    verifyToken: process.env.FB_VERIFY_TOKEN?.trim() || db.fbVerifyToken || 'msgctrl-verify',
    appSecret: process.env.FB_APP_SECRET?.trim() || db.fbAppSecret || null,
    pageId: process.env.FB_PAGE_ID?.trim() || db.fbPageId || db.pageId || null,
  };
}

/**
 * Shared HTTP surface. Used by the long-running service and by `msgctrl init` while waiting for
 * the Facebook page-selection callback.
 */
export function createHttpServer({
  serviceId,
  pageId = null,
  port = PORT,
  client = null,
  defaultDirectory = DEFAULT_DIRECTORY,
  defaultSessionId = null,
  onSelectedPages = () => {},
  onWebhookEvent = () => {},
  log = () => {},
  facebook = null,
  allowedIds = null,
} = {}) {
  const fb = facebook ?? (client ? facebookConfig() : null);
  const handle = client
    ? createCommandHandler({
        client,
        defaultDirectory,
        defaultSessionId,
        allowedIds: allowedIds ?? ownerIds(),
        send: (text, event) => {
          const recipientId = String(event?.customerInfo?.id ?? '');
          if (!recipientId) {
            console.error('[reply] no recipientId in event');
            return Promise.resolve();
          }
          log('reply', { to: recipientId, text: String(text).slice(0, 120) });
          // A failed Messenger send must never take down the webhook receiver.
          const delivery = fb
            ? sendFbMessage({ pageToken: fb.pageToken, recipientId, text })
            : (() => {
                const targetPage = String(event?.pageId ?? pageId ?? '');
                if (!targetPage) {
                  console.error('[reply] no pageId in event');
                  return Promise.resolve();
                }
                return sendMessage(serviceId, targetPage, recipientId, text);
              })();
          return delivery.catch((err) => {
            log('reply-error', {
              to: recipientId,
              error: err instanceof Error ? err.message : String(err),
            });
            console.error('[reply] OnlyOrders send failed:', err instanceof Error ? err.message : err);
          });
        },
        sendImage: (imageUrl, event) => {
          const recipientId = String(event?.customerInfo?.id ?? '');
          if (!recipientId || !fb) return Promise.resolve();
          log('reply-image', { to: recipientId, url: String(imageUrl).slice(0, 120) });
          return sendFbImage({ pageToken: fb.pageToken, recipientId, imageUrl }).catch((err) => {
            log('reply-error', {
              to: recipientId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
        log,
      })
    : null;

  let publicUrl = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        mode: fb ? 'facebook-direct' : 'onlyorders',
        serviceId: serviceId ?? null,
        pageId: fb?.pageId ?? pageId ?? null,
        tunnelUrl: publicUrl,
      });
    }

    // Meta webhook verification: GET /webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
    if (req.method === 'GET' && url.pathname === '/webhook' && fb) {
      const challenge = verifyWebhook(Object.fromEntries(url.searchParams), fb.verifyToken);
      log('verify', { ok: challenge !== null });
      if (challenge === null) return json(res, 403, { error: 'verify token mismatch' });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(challenge);
      return;
    }

    // Called by OnlyOrders' internal_facebook_url after the merchant selects Pages.
    if (req.method === 'POST' && url.pathname === '/facebook-selected') {
      const body = await readBody(req);
      log('selected', { pageName: body.pageName, pageId: body.pageId });
      const state = loadState();
      const existing = (state.selectedPages ?? []).filter(
        (page) => String(page.pageId) !== String(body.pageId),
      );
      const pages = [
        ...existing,
        {
          pageId: String(body.pageId ?? ''),
          pageName: String(body.pageName ?? ''),
          businessId: String(body.businessId ?? ''),
          at: new Date().toISOString(),
        },
      ];
      saveState({ selectedPages: pages });
      onSelectedPages(pages);
      return json(res, 200, { received: true });
    }

    if (req.method === 'GET' && url.pathname === '/selected-pages') {
      return json(res, 200, { pages: loadState().selectedPages ?? [] });
    }

    // Manual re-pointing of the webhook (tunnel URL changes are handled automatically).
    if (req.method === 'GET' && url.pathname === '/register') {
      const next = url.searchParams.get('url');
      if (!next) return json(res, 400, { error: 'Pass ?url=https://<tunnel>' });
      try {
        const db = loadDb();
        const hook = db.webhookId
          ? await updateWebhook(serviceId, db.webhookId, `${next.replace(/\/+$/, '')}/webhook`)
          : await registerWebhook(serviceId, `${next.replace(/\/+$/, '')}/webhook`);
        saveDb({ webhookId: hook.id, webhookUrl: hook.url });
        publicUrl = next;
        saveState({ tunnelUrl: next, webhookUrl: hook.url, webhookUpdatedAt: new Date().toISOString() });
        return json(res, 200, { registered: hook.url });
      } catch (err) {
        return json(res, 502, { error: String(err instanceof Error ? err.message : err) });
      }
    }

    if (req.method === 'POST' && (url.pathname === '/webhook' || url.pathname === '/')) {
      const event = await readBody(req);
      // Direct Meta format: {object:'page', entry:[...]} — normalize to the
      // OnlyOrders-shaped event the command handler already understands.
      if (event?.object === 'page' && Array.isArray(event?.entry)) {
        if (fb && !verifySignature(req.rawBody ?? '', fb.appSecret, req.headers['x-hub-signature-256'])) {
          return json(res, 403, { error: 'bad signature' });
        }
        json(res, 200, { received: true });
        setImmediate(() => {
          const msgs = parseMessengerEvents(event);
          if (!msgs.length) log('webhook-empty', { keys: Object.keys(event ?? {}) });
          for (const msg of msgs) {
            const normalized = {
              payload: { text: msg.text, mid: msg.mid, attachments: msg.attachments ?? [] },
              customerInfo: { id: msg.senderId },
              pageId: msg.pageId || fb?.pageId || pageId || '',
            };
            onWebhookEvent(normalized);
            if (handle) handle(normalized).catch((err) => console.error('[handler]', err));
          }
        });
        return;
      }
      // Legacy OnlyOrders format below.
      // ACK immediately: OnlyOrders times its webhook POST out after 10 seconds.
      json(res, 200, { received: true });
      setImmediate(() => {
        onWebhookEvent(event);
        if (handle) handle(event).catch((err) => console.error('[handler]', err));
      });
      return;
    }

    return json(res, 404, { error: 'not found' });
  });

  server.setPublicUrl = (value) => { publicUrl = value; };
  return server;
}

/** Starts the long-running runtime: OpenCode connection, quick tunnel, webhook sync, HTTP. */
export async function startRuntime({ port = PORT, logger = console } = {}) {
  loadDotenv();
  const db = loadDb();
  const fb = facebookConfig();
  const serviceId = db.serviceId ?? process.env.ONLYORDERS_SERVICE_ID?.trim();
  if (!fb && !serviceId) {
    throw new Error('No serviceId in db.json and no FB_PAGE_TOKEN — run `msgctrl init` or set FB_PAGE_TOKEN');
  }

  const { client, endpoint } = await connect();
  logger.log(`[opencode] connected to ${endpoint.url}`);

  // Give the bot its own session so Messenger prompts never loop back into the session that is
  // currently running this service/agent work.
  let botSessionId = db.botSessionId;
  if (!botSessionId) {
    const models = await listModels(client);
    const model =
      models.find((candidate) => candidate.modelID === 'hy4-flash-free') ??
      pickRandomModel(models) ??
      null;
    const session = await createSession(
      client,
      db.defaultDirectory ?? DEFAULT_DIRECTORY,
      model,
    );
    botSessionId = session.id;
    saveDb({ botSessionId });
    logger.log(`[opencode] dedicated bot session: ${botSessionId}`);
  }

  let activeServer = null;
  const onWebhookSync = async (baseUrl) => {
    activeServer?.setPublicUrl(baseUrl);
    const url = `${baseUrl.replace(/\/+$/, '')}/webhook`;
    if (fb) {
      // Direct Meta mode: the callback URL is fixed by hand in the app dashboard.
      saveState({
        tunnelUrl: baseUrl,
        webhookUrl: url,
        webhookUpdatedAt: new Date().toISOString(),
      });
      logState('webhook', `tunnel up; set Meta callback to ${url}`);
      logger.log(`[facebook] tunnel up — set Meta webhook callback to: ${url}`);
      return;
    }
    const current = loadDb();
    const hook = current.webhookId
      ? await updateWebhook(serviceId, current.webhookId, url)
      : await registerWebhook(serviceId, url);
    saveDb({ webhookId: hook.id, webhookUrl: hook.url });
    saveState({
      tunnelUrl: baseUrl,
      webhookUrl: hook.url,
      webhookUpdatedAt: new Date().toISOString(),
    });
    logState('webhook', `webhook synced to ${hook.url}`);
    logger.log(`[onlyorders] webhook synced: ${hook.url}`);
  };

  // Bind the HTTP receiver first so a port conflict fails fast and never leaves an orphan tunnel.
  const server = createHttpServer({
    serviceId,
    pageId: fb?.pageId ?? db.pageId ?? null,
    port,
    client,
    defaultDirectory: db.defaultDirectory ?? DEFAULT_DIRECTORY,
    defaultSessionId: botSessionId,
    facebook: fb,
    log: (kind, detail) => logState(kind, JSON.stringify(detail)),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  logger.log(`[server] listening on http://0.0.0.0:${port}/webhook`);

  const externalTunnel =
    process.env.MSGCTRL_EXTERNAL_TUNNEL === '1' || db.externalTunnel === true;
  let tunnel;
  let tunnelUrl;

  if (externalTunnel) {
    // Named tunnel (permanent domain): the public URL is static, no log to watch.
    const staticUrl =
      process.env.MSGCTRL_TUNNEL_URL?.trim() || loadDb().staticTunnelUrl || null;
    if (staticUrl) {
      tunnel = { url: staticUrl, stop() {} };
      tunnelUrl = staticUrl;
      await onWebhookSync(staticUrl);
    } else {
      // The tunnel runs as its own systemd unit; watch its log for URL changes.
      const logPath =
        process.env.MSGCTRL_TUNNEL_LOG ?? db.tunnelLogPath ?? path.join(homeDir(), 'msgctrl-tunnel.log');
      tunnel = watchTunnelUrl({ file: logPath, onUrl: onWebhookSync, logger });
      const deadline = Date.now() + 15_000;
      while (!tunnel.url && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      tunnelUrl = tunnel.url;
      if (!tunnelUrl) {
        logger.warn('[tunnel] no URL in service log yet — will sync when it appears');
        logState('tunnel', 'waiting for msgctrl-tunnel.service URL');
      }
    }
  } else {
    tunnel = startTunnel({
      localPort: port,
      logger,
      onUrl: onWebhookSync,
      onLog: (text) => {
        if (text.includes('ERR') || text.includes('error')) logState('tunnel', text.slice(0, 500));
      },
    });
    try {
      tunnelUrl = await tunnel.ready;
    } catch (err) {
      tunnel.stop();
      server.close();
      throw err;
    }
  }

  activeServer = server;
  server.setPublicUrl(tunnelUrl);
  logState('start', `service started on port ${port} with tunnel ${tunnelUrl ?? 'pending'}`);

  return {
    server,
    tunnel,
    tunnelUrl,
    stop() {
      tunnel.stop();
      server.close();
    },
  };
}

// Allow `npm start` / `node src/server.js` to run the long-lived service directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  startRuntime().catch((err) => {
    console.error('[startup]', err);
    process.exit(1);
  });
}
