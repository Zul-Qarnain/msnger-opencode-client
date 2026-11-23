import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createSession,
  getSession,
  getSessionHistory,
  isSessionActive,
  listModels,
  listSessions,
  pickRandomModel,
  switchModel,
} from './opencode.js';
import { createTerminal as realCreateTerminal } from './terminal.js';
import { createSessionPoller } from './poller.js';
import { saveImageAttachment, transcribeVoiceAttachment } from './voice.js';

const run = promisify(exec);

function initialState(defaultDirectory, defaultSessionId = null) {
  return {
    sessionId: defaultSessionId,
    sessionList: [],
    modelList: [],
    lastModel: null,
    cwd: defaultDirectory,
    queue: Promise.resolve(),
    permissions: new Map(),
    followGeneration: 0,
    poller: null,
    terminal: null,
  };
}

function numberedSessions(sessions) {
  if (!sessions.length) return 'No OpenCode sessions found.';
  return sessions
    .map((session, index) => {
      const title = session.title || session.id;
      const dir = session.location?.directory ? ` — ${session.location.directory}` : '';
      return `${index + 1}. ${title} (${session.id})${dir}`;
    })
    .join('\n');
}

function numberedModels(models) {
  if (!models.length) return 'No chat models are connected.';
  return models
    .map((model, index) => `${index + 1}. ${model.providerID}/${model.modelID} — ${model.name}`)
    .join('\n');
}

function parseNumber(text) {
  const match = /^\s*\d+\s*$/.exec(text);
  return match ? Number(match[0]) : null;
}

/** Reads the active session's model and name, falling back to the caller's last choice. */
async function activeModel(client, state) {
  if (state.sessionId) {
    try {
      const session = await getSession(client, state.sessionId);
      const ref = session?.model;
      if (ref?.id && ref?.providerID) {
        if (!state.modelList.length) state.modelList = await listModels(client);
        const found = state.modelList.find(
          (model) => model.modelID === ref.id && model.providerID === ref.providerID,
        );
        return found ?? { modelID: ref.id, providerID: ref.providerID, name: ref.id };
      }
    } catch {
      // The session may have just been deleted; fall back to the remembered model.
    }
  }
  if (state.lastModel) return state.lastModel;
  if (!state.modelList.length) state.modelList = await listModels(client);
  return state.modelList[0] ?? envModel();
}

function formatPermission(permission) {
  const resources = permission.resources ? `\nresources: ${permission.resources}` : '';
  const message = permission.message ? `\nmessage: ${permission.message}` : '';
  return (
    `permission asked [${permission.id}]: ${permission.action}${resources}${message}` +
    `\nreply: /allow ${permission.id} | /always ${permission.id} | /reject ${permission.id}`
  );
}

/** Handles permission events for a single Messenger caller. */
function permissionHandler(state, reply) {
  return (permission) => {
    if (permission.resolved) {
      state.permissions.delete(permission.id);
      return reply(`permission resolved: ${permission.id}`);
    }
    state.permissions.set(permission.id, permission);
    return reply(formatPermission(permission));
  };
}

/** Compact token counts: 950 → "950", 1500 → "1.5k", 2_300_000 → "2.30M". */
function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtDur(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
}
function modelLabel(model) {
  if (!model) return 'default';
  const variant = model.variant ? ` [${model.variant}]` : '';
  return `${model.providerID}/${model.modelID}${variant} — ${model.name ?? ''}`;
}

function formatHistory(turns) {
  if (!turns.length) return 'History: (none yet)';
  return (
    'Last 3 turns:\n' +
    turns
      .map((turn, index) => {
        const answer = turn.assistant ?? '(no reply yet)';
        return `#############\n${index + 1}. You: ${turn.user}\n   OpenCode: ${answer}`;
      })
      .join('\n') + '\n#############'
  );
}

/** Optional deployment override, e.g. OPENCODE_MODEL=opencode/hy4-flash-free. */
function envModel() {
  const combined = process.env.OPENCODE_MODEL?.trim();
  if (combined?.includes('/')) {
    const [providerID, ...rest] = combined.split('/');
    const modelID = rest.join('/');
    return { modelID, providerID, name: combined };
  }
  const modelID = process.env.OPENCODE_MODEL_ID?.trim();
  const providerID = process.env.OPENCODE_PROVIDER_ID?.trim();
  return modelID && providerID ? { modelID, providerID, name: `${providerID}/${modelID}` } : null;
}

/**
 * Builds the webhook handler. Dependencies are injected so the whole command surface can be
 * unit-tested without a live OpenCode service or Messenger connection.
 */
export function createCommandHandler({
  client,
  send,
  defaultDirectory = process.cwd(),
  log = () => {},
  execCommand = run,
  createTerminal = realCreateTerminal,
  createSessionPoller: makePoller = createSessionPoller,
  defaultSessionId = null,
  transcribeVoice = transcribeVoiceAttachment,
  saveImage = saveImageAttachment,
  allowedIds = null,
  sendImage = null,
}) {
  const states = new Map();
  const allowed = allowedIds?.length ? new Set(allowedIds) : null;

  function stopPoller(state) {
    if (state.poller) {
      state.poller.stop();
      state.poller = null;
    }
    state.followGeneration += 1;
  }

  function startPoller(state, sessionID, reply) {
    stopPoller(state);
    const generation = state.followGeneration;
    const send = (message) => (generation === state.followGeneration ? reply(message) : undefined);
    state.poller = makePoller({
      client,
      sessionID,
      onThinking: () => {},
      onReply: send,
      onError: (error) => send(`error [poll]: ${error}`),
      onPermission: permissionHandler(state, send),
      intervalMs: Number(process.env.MSGCTRL_POLL_MS ?? 3000),
      logger: { error: (message) => log('poll-error', { message }) },
    });
    log('poll-start', { sessionID, generation });
  }

  /** Attaches a caller and starts the polling worker that owns all output from now on. */
  async function attachAndReport(state, session, label, reply) {
    stopPoller(state);
    state.sessionId = session.id;
    const running = await isSessionActive(client, session.id);
    const model = await activeModel(client, state);
    const history = await getSessionHistory(client, session.id, 3);
    const modelText = modelLabel(model);
    const status = running
      ? 'Operation running and reporting from now.'
      : 'No operation is currently running on this session.';

    await reply(
      `Attached successfully to ${label}: ${session.id}\n${session.title ?? ''}\n` +
        `active model: ${modelText}\n${status}\n\n${formatHistory(history)}`,
    );
    // Polling starts at attach time and stays until /exit, another attach, or terminal mode.
    startPoller(state, session.id, reply);
    return undefined;
  }

  async function refreshSessions(state) {
    state.sessionList = await listSessions(client);
    return state.sessionList;
  }

  async function refreshModels(state) {
    state.modelList = await listModels(client);
    return state.modelList;
  }

  async function runShell(body, state, reply) {
    const command = body.slice(1).trim();
    if (!command) return reply('Usage: !<command>');

    const cd = /^cd\s+(.+)$/.exec(command);
    if (cd) {
      state.cwd = cd[1].trim();
      return reply(`Working directory: ${state.cwd}`);
    }

    log('shell', { command: command.slice(0, 200), cwd: state.cwd });
    try {
      const { stdout, stderr } = await execCommand(command, {
        cwd: state.cwd ?? defaultDirectory,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const output = `${stdout ?? ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
      return reply(`$ ${command}\n${output || '(no output)'}`);
    } catch (err) {
      const output = `${err.stdout ?? ''}${err.stderr ? `\n${err.stderr}` : ''}`.trim();
      return reply(`$ ${command}\nFAILED: ${err.message}\n${output}`.trim());
    }
  }

  async function handle(event) {
    let text = String(event?.payload?.text ?? '').trim();
    const attachments = event?.payload?.attachments ?? [];
    if (!text && !attachments.length) return;

    const key = String(event?.customerInfo?.id ?? 'global');
    const state = states.get(key) ?? initialState(defaultDirectory, defaultSessionId);
    states.set(key, state);
    const pageId = String(event?.pageId ?? '');
    const reply = (message) => send(message, event);

    // Owner-only mode: strangers are dropped silently (logged, never answered).
    const senderId = String(event?.customerInfo?.id ?? '');
    if (allowed && senderId && !allowed.has(senderId)) {
      log('blocked', { from: senderId });
      return;
    }

    // A default session may be set at startup; begin polling on the first interaction so output
    // from any already-running turn is reported without waiting for an explicit attach.
    if (state.sessionId && !state.poller && !state.terminal) {
      startPoller(state, state.sessionId, reply);
    }

    // Voice note → Deepgram transcript becomes the prompt. Image → saved on disk.
    if (!text || text.startsWith('[attachment')) {
      const audio = attachments.find((a) => /audio|voice/.test(a.type ?? ''));
      const image = attachments.find((a) => (a.type ?? '') === 'image');
      if (audio) {
        await reply('🎤 transcribing voice…');
        try {
          const { transcript } = await transcribeVoice(audio);
          text = transcript;
          await reply(`🎤 you said: ${transcript}`);
        } catch (err) {
          return reply(`voice failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (image) {
        try {
          const saved = await saveImage(image, event?.payload?.mid);
          return reply(`📷 image saved (${Math.max(1, Math.round(saved.bytes / 1024))}kb)`);
        } catch (err) {
          return reply(`image save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Full terminal mode: every subsequent message is a command until /exit or `exit`.
    if (state.terminal) {
      if (/^\/exit$/i.test(text)) {
        state.terminal.kill();
        state.terminal = null;
        return reply('terminal closed');
      }
      if (/^(exit|logout)\s*$/i.test(text)) {
        state.terminal.send('exit');
        return undefined; // onExit replies and clears the mode.
      }
      try {
        await state.terminal.run(text);
        if (/^\s*cd\b/i.test(text)) return reply(`cwd: ${state.terminal?.cwd}`);
      } catch (err) {
        return reply(`terminal error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    }

    if (/^\/bash$/i.test(text)) {
      if (state.terminal) return reply('terminal already open');
      stopPoller(state);
      state.terminal = createTerminal({
        cwd: '/home',
        onOutput: (text) => reply(text),
        onExit: (code) => {
          if (!state.terminal) return;
          state.terminal = null;
          state.followGeneration += 1;
          reply(`terminal exited (code ${code})`);
        },
      });
      return reply('terminal opened at /home. Send shell commands; /exit or `exit` closes it.');
    }

    if (/^\/help$/i.test(text)) {
      return reply(
        'Commands:\n' +
          '/session — list OpenCode sessions\n' +
          '/session N — attach to session N\n' +
          '/session new /dir — create + attach a session in /dir\n' +
          '/session pwd — show attached session + model\n' +
          '/model ls — list connected models\n' +
          '/models N — switch attached session to model N\n' +
          '/model pwd — show active model\n' +
          '/compact — compact the attached session\n' +
          '/status — live task status: working time, progress, token usage\n' +
          '/bash — open persistent terminal at /home\n' +
          '!<cmd> — run a shell command (e.g. !ls, !cd /tmp)\n' +
          '/img <url> — send an image by public URL\n' +
          '/allow|/always|/reject <id> — answer a permission request\n' +
          '/exit — detach session / close terminal\n' +
          '/help — this list\n' +
          'anything else — prompt the attached session',
      );
    }

    try {
      // Shell escape hatch
      if (text.startsWith('!')) return await runShell(text, state, reply);

      // Detach from current session
      if (/^\/exit$/i.test(text)) {
        stopPoller(state);
        state.sessionId = null;
        return reply('session exited');
      }

      // /session, /session N, /session new /path
      const sessionMatch = /^\/session(?:\s+(.+))?$/i.exec(text);
      if (sessionMatch) {
        const arg = sessionMatch[1]?.trim();
        if (/^pwd$/i.test(arg ?? '')) {
          if (!state.sessionId) return reply('No active session. Connect one with /session first.');
          const session = await getSession(client, state.sessionId);
          const model = await activeModel(client, state);
          return reply(
            `Active session: ${session?.title ?? state.sessionId} (${state.sessionId})\ndirectory: ${session?.location?.directory ?? state.cwd}\nactive model: ${modelLabel(model)}`,
          );
        }
        if (!arg) {
          const sessions = await refreshSessions(state);
          return reply(`OpenCode sessions:\n${numberedSessions(sessions)}`);
        }
        if (/^new(?:\s+(.*))?$/i.test(arg)) {
          const dirMatch = /^new\s+(.+)$/i.exec(arg);
          const directory = dirMatch ? dirMatch[1].trim() : state.cwd ?? defaultDirectory;
          let model = state.lastModel ?? envModel();
          if (!model) {
            model = pickRandomModel(await refreshModels(state));
          }
          const session = await createSession(client, directory, model);
          if (model) state.lastModel = model;
          await attachAndReport(state, session, `new session in ${directory}`, reply);
          return undefined;
        }
        const number = parseNumber(arg);
        if (!number) return reply('Usage: /session [number | new /directory]');
        if (!state.sessionList.length) await refreshSessions(state);
        const session = state.sessionList[number - 1];
        if (!session) return reply(`No session number ${number}. Send /session to see the list.`);
        await attachAndReport(state, session, `session ${number}`, reply);
        return undefined;
      }

      // /model ls and /models N (both spellings accepted)
      const modelMatch = /^\/models?(?:\s+(.+))?$/i.exec(text);
      if (modelMatch) {
        const arg = modelMatch[1]?.trim();
        if (/^pwd$/i.test(arg ?? '')) {
          const model = await activeModel(client, state);
          if (!model) return reply('No active model. Connect a session first.');
          return reply(
            `Active model: ${modelLabel(model)}\nsession: ${state.sessionId ?? 'none'}`,
          );
        }
        if (!arg || /^ls$/i.test(arg)) {
          const models = await refreshModels(state);
          return reply(`Connected models:\n${numberedModels(models)}`);
        }
        if (!state.sessionId) {
          const sessions = await refreshSessions(state);
          return reply(
            `No session attached — connect one first:\n${numberedSessions(sessions)}`,
          );
        }
        const number = parseNumber(arg);
        if (!number) return reply('Usage: /model ls | /models <number>');
        if (!state.modelList.length) await refreshModels(state);
        const model = state.modelList[number - 1];
        if (!model) return reply(`No model number ${number}. Send /model ls to see the list.`);
        await switchModel(client, state.sessionId, model);
        state.lastModel = model;
        return reply(`session ${state.sessionId} now uses ${model.providerID}/${model.modelID}`);
      }

      // Compact the attached session to free context.
      const compactMatch = /^\/compact$/i.exec(text);
      if (compactMatch) {
        if (!state.sessionId) return reply('No active session. Connect one with /session first.');
        try {
          await client.session.compact({ sessionID: state.sessionId });
          return reply('session compacted');
        } catch (err) {
          return reply(`compact failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Send an image by public URL (direct Facebook mode only).
      const imgMatch = /^\/img\s+(.+)$/i.exec(text);
      if (imgMatch) {
        const imageUrl = imgMatch[1].trim();
        if (!/^https?:\/\//i.test(imageUrl)) return reply('Usage: /img <public-image-url>');
        if (!sendImage) return reply('image sending needs direct Facebook mode');
        try {
          await sendImage(imageUrl, event);
          return undefined;
        } catch (err) {
          return reply(`image send failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Live status: working time, progress of the current turn, token usage.
      const statusMatch = /^\/status$/i.exec(text);
      if (statusMatch) {
        if (!state.sessionId) return reply('No active session. Connect one with /session first.');
        const session = await getSession(client, state.sessionId);
        const model = await activeModel(client, state);
        const running = await isSessionActive(client, state.sessionId);
        const now = Date.now();
        const busy = session?.time?.busy ?? 0;
        const idle = session?.time?.idle ?? 0;
        const timeLine = running
          ? `working for ${fmtDur(now - busy)} (since ${new Date(busy).toLocaleTimeString()})`
          : busy && idle
            ? `last run ${fmtDur(idle - busy)}, idle for ${fmtDur(now - idle)}`
            : 'no run recorded yet';
        const history = await getSessionHistory(client, state.sessionId, 1);
        const last = history.at(-1);
        const progress = !last
          ? 'no prompts yet'
          : last.assistant
            ? `last prompt answered: "${String(last.user).slice(0, 80)}"`
            : `in progress: "${String(last.user).slice(0, 80)}"`;
        let input = 0, output = 0, reasoning = 0, cacheRead = 0;
        try {
          const all = await client.message.list({ sessionID: state.sessionId, limit: 100, order: 'desc' });
          for (const m of all.data ?? []) {
            if (m.type !== 'assistant' || !m.tokens) continue;
            input += m.tokens.input ?? 0;
            output += m.tokens.output ?? 0;
            reasoning += m.tokens.reasoning ?? 0;
            cacheRead += m.tokens.cache?.read ?? 0;
          }
        } catch { /* token totals are best-effort */ }
        return reply(
          `Status: ${session?.title ?? state.sessionId} (${state.sessionId})\n` +
            `directory: ${session?.location?.directory ?? state.cwd}\n` +
            `model: ${modelLabel(model)}\n` +
            `${running ? '●' : '○'} ${timeLine}\n` +
            `${progress}\n` +
            `tokens: ${fmtTokens(input)} in / ${fmtTokens(output)} out / ${fmtTokens(reasoning)} reasoning / ${fmtTokens(cacheRead)} cache`,
        );
      }

      // Permission decisions: /allow <id>, /always <id>, /reject <id>
      const permissionMatch = /^\/(allow|always|reject)\s+(.+)$/i.exec(text);
      if (permissionMatch) {
        const decision =
          permissionMatch[1].toLowerCase() === 'allow'
            ? 'once'
            : permissionMatch[1].toLowerCase();
        const id = permissionMatch[2].trim();
        const pending = state.permissions.get(id);
        if (!pending) return reply(`No pending permission with id ${id}`);
        await client.permission.reply({
          sessionID: pending.sessionID,
          requestID: pending.id,
          decision,
        });
        state.permissions.delete(pending.id);
        return reply(`permission ${decision}: ${pending.id}`);
      }

      // Anything else is a prompt, but only when a session is attached.
      if (!state.sessionId) {
        const sessions = await refreshSessions(state);
        return reply(
          `No session currently attached. Connect one and send your message again:\n${numberedSessions(sessions)}`,
        );
      }

      log('prompt', { sessionId: state.sessionId, pageId, length: text.length });
      // One OpenCode session must not run two prompt subscriptions at once: each subscription
      // would capture the other's text deltas and produce mixed/duplicated final replies.
      // Queue prompts per caller so turns are processed strictly one after another.
      const runPrompt = async () => {
        // Do not listen for output here — the polling worker owns that. Just enqueue the turn.
        await client.session.prompt({ sessionID: state.sessionId, text });
        return undefined;
      };
      state.queue = state.queue.then(runPrompt, runPrompt);
      return state.queue;
    } catch (err) {
      log('error', { message: err instanceof Error ? err.message : String(err) });
      if (err?.forwarded) return undefined;
      return reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return handle;
}
