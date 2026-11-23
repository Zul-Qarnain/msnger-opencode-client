import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { opencodeBinary, opencodeRuntime } from './services.js';

/** Cheap CLI-level check used by `msgctrl init` before the SDK connection is attempted. */
export function isOpencodeAvailable() {
  const runtime = opencodeRuntime(opencodeBinary());
  return Boolean(runtime.url) || runtime.error === null;
}

export { opencodeBinary };

/** Discovers (or starts) the local OpenCode service and returns a typed client. */
export async function connect() {
  const endpoint = await Service.ensure();
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  return { client, endpoint };
}

export async function listSessions(client, limit = 50) {
  const result = await client.session.list({ limit, order: 'desc' });
  return result.data ?? [];
}

export async function getSession(client, sessionID) {
  return client.session.get({ sessionID });
}

/**
 * Last conversation turns: user messages paired with the assistant's final text only.
 * Reasoning and tool-call content is filtered out.
 */
export async function getSessionHistory(client, sessionID, turns = 3) {
  // Fetch newest-first (the SDK default) and sort by the message timestamp. Using order:'asc'
  // with a limit would return the OLDEST N messages on a long session, not the latest turns.
  const result = await client.message.list({ sessionID, limit: 100, order: 'desc' });
  const messages = (result.data ?? [])
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  const history = [];

  for (const message of messages) {
    if (message.type === 'user') {
      history.push({ user: String(message.text ?? ''), assistant: null });
    } else if (message.type === 'assistant' && history.length) {
      const text = (message.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => String(part.text ?? ''))
        .join('\n')
        .trim();
      if (text) history[history.length - 1].assistant = text;
    }
  }

  return history.slice(-turns);
}

export async function listModels(client) {
  const result = await client.model.list();
  return (result.data ?? []).filter((model) => model.enabled !== false && model.type !== 'image' && model.type !== 'video');
}

export function modelRef(model) {
  return { id: model.modelID, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) };
}

/** Applies OPENCODE_MODEL_VARIANT (e.g. xhigh) to a model that has none set. */
export function applyVariant(model) {
  const variant = process.env.OPENCODE_MODEL_VARIANT?.trim();
  if (model && variant && !model.variant) return { ...model, variant };
  return model;
}

export function pickRandomModel(models) {
  const chat = models.filter((model) => !model.type || model.type === 'chat');
  const pool = chat.length ? chat : models;
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function createSession(client, directory, model) {
  return client.session.create({
    location: { directory },
    ...(model ? { model: modelRef(applyVariant(model)) } : {}),
    title: 'Messenger control panel',
  });
}

export async function switchModel(client, sessionID, model) {
  await client.session.switchModel({ sessionID, model: modelRef(applyVariant(model)) });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when OpenCode reports a turn currently executing in this session. */
export async function isSessionActive(client, sessionID) {
  try {
    const active = await client.session.active();
    if (active?.[sessionID]) return true;
  } catch {
    // Older servers may not expose /session/active; fall back to session timestamps.
  }
  try {
    const session = await getSession(client, sessionID);
    const busy = session?.time?.busy ?? 0;
    const idle = session?.time?.idle ?? 0;
    return Boolean(busy && busy > idle);
  } catch {
    return false;
  }
}

/**
 * Shared live event stream. With `text` it sends a prompt first; without it, it only reports on
 * work already running. Either way it forwards reasoning, errors, permissions and the final text,
 * never replaying anything older than the moment the subscription started.
 */
async function streamTurn({
  client,
  sessionID,
  text = null,
  onThinking = () => {},
  onError = () => {},
  onPermission = () => {},
  timeoutMs = Number(process.env.MSGCTRL_TIMEOUT_MS ?? 600_000),
}) {
  const sending = text !== null;
  const controller = new AbortController();
  const chunks = new Map();
  let done = false;
  let failed = null;
  let markConnected;
  const connected = new Promise((resolve) => { markConnected = resolve; });

  const emittedErrors = new Set();
  const errorSends = [];
  const emitError = (message, type) => {
    const value = String(message ?? '').trim();
    if (!value || emittedErrors.has(value)) return;
    emittedErrors.add(value);
    const label = type ? `error [${type}]: ${value}` : `error: ${value}`;
    errorSends.push(Promise.resolve(onError(label)).catch((err) => {
      console.error('[opencode] failed to forward error', err);
    }));
  };

  const subscription = (async () => {
    try {
      for await (const event of client.event.subscribe({
        types: [
          'server.connected',
          'permission.asked',
          'permission.replied',
          'session.reasoning.ended',
          'session.text.delta',
          'session.idle',
          'session.execution.succeeded',
          'session.step.failed',
          'session.retry.scheduled',
          'session.execution.failed',
          'session.execution.interrupted',
        ],
        signal: controller.signal,
      })) {
        if (event.type === 'server.connected') {
          markConnected();
          continue;
        }
        const data = event.data ?? {};
        if (event.type === 'permission.asked' && data.sessionID === sessionID) {
          const resources = Array.isArray(data.resources) ? data.resources.join(', ') : '';
          onPermission({
            id: String(data.id ?? ''),
            sessionID,
            action: String(data.action ?? 'permission'),
            resources,
            message: String(data.message ?? '').trim(),
            raw: data,
          });
        } else if (
          event.type === 'permission.replied' &&
          data.sessionID === sessionID &&
          data.requestID
        ) {
          onPermission({ resolved: true, id: String(data.requestID), sessionID, raw: data });
        } else if (event.type === 'session.reasoning.ended' && data.sessionID === sessionID) {
          const thought = String(data.text ?? '').trim();
          if (thought) onThinking(thought);
        } else if (event.type === 'session.text.delta' && data.sessionID === sessionID) {
          const id = data.assistantMessageID ?? 'default';
          chunks.set(id, (chunks.get(id) ?? '') + (data.delta ?? ''));
        } else if (
          (event.type === 'session.step.failed' ||
            event.type === 'session.retry.scheduled' ||
            event.type === 'session.execution.failed' ||
            event.type === 'session.execution.interrupted') &&
          data.sessionID === sessionID
        ) {
          const message =
            data.error?.message ??
            (event.type === 'session.execution.interrupted'
              ? `execution interrupted (${data.reason ?? 'unknown'})`
              : event.type);
          emitError(message, event.type);
          if (
            event.type === 'session.execution.failed' ||
            event.type === 'session.execution.interrupted'
          ) {
            failed = message;
            done = true;
            break;
          }
        } else if (
          (event.type === 'session.idle' || event.type === 'session.execution.succeeded') &&
          data.sessionID === sessionID
        ) {
          done = true;
          break;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        failed = err instanceof Error ? err.message : String(err);
        emitError(failed, 'subscription');
      }
    }
  })();

  const startedAt = Date.now();
  try {
    await Promise.race([connected, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (sending) await client.session.prompt({ sessionID, text });

    const deadline = Date.now() + timeoutMs;
    while (!done && Date.now() < deadline) await sleep(250);
    if (!done) {
      const partial = Array.from(chunks.values()).join('\n').trim();
      if (partial) {
        // The turn is still running, but the assistant has already produced text. Deliver it
        // instead of turning a long-but-working reply into an error.
        done = true;
      } else {
        failed = 'timeout waiting for OpenCode reply';
        emitError(failed, 'timeout');
      }
    }
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
    emitError(failed, sending ? 'prompt' : 'follow');
  } finally {
    controller.abort();
    await Promise.race([subscription.catch(() => {}), sleep(1000)]);
  }

  await Promise.allSettled(errorSends);
  if (failed) {
    const error = new Error(String(failed));
    error.forwarded = true;
    throw error;
  }

  let replyText = Array.from(chunks.values()).join('\n').trim();
  if (!replyText) {
    // A reply may already have been partly streamed before this listener attached. Fetch the
    // newest assistant message created since the listener started.
    try {
      const messages = await client.message.list({ sessionID, limit: 10, order: 'desc' });
      const assistant = (messages.data ?? []).find(
        (message) =>
          message.type === 'assistant' &&
          (message.time?.created ?? 0) >= startedAt - 2000 &&
          (message.content ?? []).some((part) => part.type === 'text'),
      );
      if (assistant) {
        replyText = (assistant.content ?? [])
          .filter((part) => part.type === 'text')
          .map((part) => String(part.text ?? ''))
          .join('\n')
          .trim();
      }
    } catch {
      // The live stream is the primary source; history is only a safety net.
    }
  }
  return replyText || '(OpenCode returned no text)';
}

/** Sends a new prompt and waits for the final assistant text. */
export function promptAndWait(
  client,
  sessionID,
  text,
  onThinking = () => {},
  onError = () => {},
  onPermission = () => {},
  timeoutMs = 180_000,
) {
  return streamTurn({ client, sessionID, text, onThinking, onError, onPermission, timeoutMs });
}

/** Listens to work already running in a session, without sending a new prompt. */
export function followSession(
  client,
  sessionID,
  { onThinking = () => {}, onError = () => {}, onPermission = () => {}, timeoutMs = 180_000 } = {},
) {
  return streamTurn({ client, sessionID, onThinking, onError, onPermission, timeoutMs });
}
