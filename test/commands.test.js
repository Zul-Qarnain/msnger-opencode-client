import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandHandler } from '../src/commands.js';
import { splitText } from '../src/onlyorders.js';

function makeClient({
  sessions,
  models,
  thoughts = ['Let me check the answer.'],
  failStep = false,
  permission = false,
  active = false,
} = {}) {
  const sessionList = sessions ?? [
    { id: 's1', title: 'Session One', location: { directory: '/home/ubuntu/Oryxa' } },
    { id: 's2', title: 'Session Two', location: { directory: '/tmp' } },
  ];
  const modelList = models ?? [
    { providerID: 'opencode', modelID: 'm1', name: 'Model One', type: 'chat', enabled: true },
    { providerID: 'anthropic', modelID: 'm2', name: 'Model Two', type: 'chat', enabled: true },
  ];
  const calls = { create: [], switchModel: [], prompt: [], permissionReply: [] };

  const client = {
    session: {
      list: async () => ({ data: sessionList }),
      create: async (input) => {
        calls.create.push(input);
        const created = { id: 'new-1', title: input.title, location: input.location };
        sessionList.push(created);
        return created;
      },
      switchModel: async (input) => calls.switchModel.push(input),
      prompt: async (input) => {
        calls.prompt.push(input);
      },
      get: async ({ sessionID }) =>
        sessionList.find((s) => s.id === sessionID) ?? sessionList[0],
      active: async () => (active ? { s1: { type: 'running' } } : {}),
    },
    permission: {
      request: {
        list: async () => ({
          data: permission
            ? [{ id: 'perm-1', sessionID: 's1', action: 'write', resources: ['/tmp/file.txt'], message: 'Allow writing the file?' }]
            : [],
        }),
      },
      reply: async (input) => calls.permissionReply.push(input),
    },
    message: {
      // SDK returns newest-first; timestamps are explicit so sorting is verifiable.
      list: async () => ({
        data: [
          { id: 'm3', type: 'assistant', time: { created: 400, completed: 401 }, content: [{ type: 'text', text: 'third answer' }] },
          { id: 'u3', type: 'user', time: { created: 399 }, text: 'third question' },
          { id: 'm2', type: 'assistant', time: { created: 300, completed: 301 }, content: [{ type: 'text', text: 'second answer' }] },
          { type: 'user', time: { created: 299 }, text: 'second question' },
          {
            id: 'm1',
            type: 'assistant',
            time: { created: 200, completed: 201 },
            content: [
              { type: 'reasoning', text: 'thinking...' },
              { type: 'text', text: 'first answer' },
              { type: 'tool', name: 'write' },
            ],
          },
          { type: 'user', time: { created: 199 }, text: 'first question' },
          { id: 'm0', type: 'assistant', time: { created: 100, completed: 101 }, content: [{ type: 'text', text: 'old answer' }] },
          { type: 'user', time: { created: 99 }, text: 'old question' },
        ],
      }),
    },
    model: { list: async () => ({ data: modelList }) },
    event: {
      subscribe: () =>
        (async function* () {
          yield { type: 'server.connected', data: {} };
          for (const thought of thoughts) {
            yield {
              type: 'session.reasoning.ended',
              data: { sessionID: 's1', text: thought },
            };
          }
          // Tool chatter must NOT reach Messenger. A failed tool step must not abort the reply.
          yield { type: 'session.tool.called', data: { sessionID: 's1', tool: 'write' } };
          if (failStep) {
            yield {
              type: 'session.step.failed',
              data: { sessionID: 's1', error: { message: 'one tool failed' } },
            };
          }
          if (permission) {
            yield {
              type: 'permission.asked',
              data: {
                id: 'perm-1',
                sessionID: 's1',
                action: 'write',
                resources: ['/tmp/file.txt'],
                message: 'Allow writing the file?',
              },
            };
          }
          yield {
            type: 'session.text.delta',
            data: { sessionID: 's1', assistantMessageID: 'a1', delta: 'Hello ' },
          };
          yield {
            type: 'session.text.delta',
            data: { sessionID: 's1', assistantMessageID: 'a1', delta: 'from OpenCode' },
          };
          yield { type: 'session.idle', data: { sessionID: 's1' } };
        })(),
    },
  };
  return { client, calls, sessionList, modelList };
}

function setup(overrides = {}) {
  const replies = [];
  const { client, calls, sessionList, modelList } = makeClient(overrides);
  const execCommand = async (command) => ({ stdout: `output of ${command}`, stderr: '' });
  let poller = null;
  const handle = createCommandHandler({
    client,
    execCommand,
    defaultDirectory: '/default',
    send: async (text, event) => replies.push({ text, event }),
    createSessionPoller: (options) => {
      poller = {
        ...options,
        stopped: false,
        tick: () => {
          options.onThinking?.('Let me check the answer.');
          options.onReply?.('Hello from OpenCode');
        },
        stop() { this.stopped = true; },
      };
      return poller;
    },
  });
  const incoming = (text, attachments) =>
    handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text, attachments } });
  return {
    replies,
    calls,
    sessionList,
    modelList,
    incoming,
    get poller() { return poller; },
  };
}

test('/session pwd and /model pwd show active session and model', async () => {
  const { replies, incoming } = setup();
  await incoming('/session 1');
  await incoming('/session pwd');
  assert.match(replies.at(-1).text, /Active session: Session One \(s1\)/);
  assert.match(replies.at(-1).text, /active model:/);
  await incoming('/model pwd');
  assert.match(replies.at(-1).text, /Active model:/);
  assert.match(replies.at(-1).text, /session: s1/);
});

test('attaching to the control session is allowed (guardrail removed)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msgctrl-control-'));
  const previousHome = process.env.MSGCTRL_HOME;
  process.env.MSGCTRL_HOME = tmp;
  try {
    fs.writeFileSync(path.join(tmp, 'db.json'), JSON.stringify({ controlSessionId: 's-control' }));
    const replies = [];
    const { client } = makeClient({
      sessions: [{ id: 's-control', title: 'Control session', location: { directory: '/tmp' } }],
    });
    const handle = createCommandHandler({
      client,
      defaultDirectory: '/default',
      send: async (text) => replies.push(text),
      createSessionPoller: () => ({ stop() {}, tick() {} }),
    });
    await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session' } });
    assert.doesNotMatch(replies.join('\n'), /do not attach/);
    replies.length = 0;
    await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
    assert.match(replies[0], /Attached successfully to session 1: s-control/);
    assert.doesNotMatch(replies.join('\n'), /control session running this assistant/);
  } finally {
    if (previousHome === undefined) delete process.env.MSGCTRL_HOME;
    else process.env.MSGCTRL_HOME = previousHome;
  }
});

test('attaching to a session sends confirmation, model and last turns without tool chatter', async () => {
  const { replies, incoming } = setup();
  await incoming('/session 1');
  const text = replies.at(-1).text;
  assert.match(text, /Attached successfully to session 1/);
  assert.match(text, /active model:/);
  assert.match(text, /You: first question/);
  assert.match(text, /OpenCode: first answer/);
  assert.match(text, /You: second question/);
  assert.match(text, /OpenCode: second answer/);
  assert.match(text, /You: third question/);
  assert.match(text, /OpenCode: third answer/);
  assert.match(text, /#############/);
  assert.doesNotMatch(text, /old question|old answer|thinking\.\.\.|write_tool/);
});

test('attaching to an idle session says no operation is running', async () => {
  const replies = [];
  const { client } = makeClient({ active: false });
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  assert.match(replies[0], /Attached successfully to session 1/);
  assert.match(replies[0], /No operation is currently running on this session/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(replies.length, 1);
});

test('attaching to a running session starts polling and streams from that moment', async () => {
  const replies = [];
  const { client } = makeClient({ active: true });
  let poller;
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createSessionPoller: (options) => {
      poller = {
        ...options,
        stop() {},
        tick: () => {
          options.onThinking?.('Let me check the answer.');
          options.onReply?.('Hello from OpenCode');
        },
      };
      return poller;
    },
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  assert.match(replies[0], /Operation running and reporting from now/);
  assert.equal(poller.sessionID, 's1');
  poller.tick();
  const joined = replies.join('\n');
  assert.doesNotMatch(joined, /thinking:/);
  assert.match(joined, /Hello from OpenCode/);
});

test('permission requests are forwarded and can be answered from Messenger', async () => {
  const replies = [];
  const { client, calls } = makeClient({ permission: true });
  let poller;
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createSessionPoller: (options) => {
      poller = {
        ...options,
        stop() {},
        tick: () => options.onPermission?.({
          id: 'perm-1',
          sessionID: 's1',
          action: 'write',
          resources: ['/tmp/file.txt'],
          message: 'Allow writing the file?',
        }),
      };
      return poller;
    },
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  replies.length = 0;
  poller.tick();
  const forwarded = replies.find((r) => r.startsWith('permission asked'));
  assert.match(forwarded, /permission asked \[perm-1\]: write/);
  assert.match(forwarded, /resources: \/tmp\/file\.txt/);
  assert.match(forwarded, /\/allow perm-1/);

  replies.length = 0;
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/allow perm-1' } });
  assert.deepEqual(calls.permissionReply, [
    { sessionID: 's1', requestID: 'perm-1', decision: 'once' },
  ]);
  assert.equal(replies.at(-1), 'permission once: perm-1');
});

test('a failed tool step does not prevent the final reply', async () => {
  const replies = [];
  const { client } = makeClient({ failStep: true });
  let poller;
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createSessionPoller: (options) => {
      poller = {
        ...options,
        stop() {},
        tick: () => {
          options.onError?.('one tool failed');
          options.onReply?.('Hello from OpenCode');
        },
      };
      return poller;
    },
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  replies.length = 0;
  poller.tick();
  assert.equal(replies.at(-1), 'Hello from OpenCode');
  assert.match(replies.join('\n'), /error \[poll\]: one tool failed/);
});

test('thinking output is swallowed, only the final answer is delivered', async () => {
  const replies = [];
  const { client } = makeClient();
  let poller;
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createSessionPoller: (options) => {
      poller = {
        ...options,
        stop() {},
        tick: () => {
          for (const thought of ['step one', 'step two', 'step three', 'step four', 'step five']) {
            options.onThinking?.(thought);
          }
          options.onReply?.('Hello from OpenCode');
        },
      };
      return poller;
    },
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  replies.length = 0;
  poller.tick();
  assert.deepEqual(replies, ['Hello from OpenCode']);
});

test('/bash opens a stateful terminal, streams output and /exit closes it', async () => {
  const replies = [];
  const commands = [];
  let killed = false;
  let options;

  const terminal = {
    cwd: '/home',
    alive: true,
    run: async (command) => {
      commands.push(command);
      if (command.startsWith('cd ')) terminal.cwd = command.slice(3).trim();
    },
    send: () => {},
    kill: () => { killed = true; },
  };
  const { client } = makeClient();
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createTerminal: (opts) => { options = opts; return terminal; },
  });
  const incoming = (text) =>
    handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text } });

  await incoming('/bash');
  assert.equal(options.cwd, '/home');
  assert.match(replies.at(-1), /terminal opened at \/home/);

  await incoming('cd /sbin');
  assert.deepEqual(commands, ['cd /sbin']);
  assert.equal(terminal.cwd, '/sbin');
  assert.equal(replies.at(-1), 'cwd: /sbin');

  options.onOutput('first log line\n');
  assert.equal(replies.at(-1), 'first log line\n');
  options.onOutput('still running...\n');
  assert.equal(replies.at(-1), 'still running...\n');

  await incoming('ls');
  assert.deepEqual(commands, ['cd /sbin', 'ls']);

  await incoming('/exit');
  assert.equal(killed, true);
  assert.equal(replies.at(-1), 'terminal closed');

  replies.length = 0;
  await incoming('hello');
  assert.match(replies.at(-1), /No session currently attached/);
});

test('typing exit inside the terminal closes terminal mode', async () => {
  const replies = [];
  let options;
  const terminal = {
    cwd: '/home',
    alive: true,
    run: async () => {},
    send: () => options.onExit(0),
    kill: () => {},
  };
  const { client } = makeClient();
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createTerminal: (opts) => { options = opts; return terminal; },
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/bash' } });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: 'exit' } });
  assert.match(replies.at(-1), /terminal exited \(code 0\)/);

  replies.length = 0;
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: 'pwd' } });
  assert.match(replies.at(-1), /No session currently attached/);
});

test('defaultSessionId makes normal messages prompts without attaching first', async () => {
  const replies = [];
  const { client, calls } = makeClient();
  let poller;
  const handleWithPoller = createCommandHandler({
    client,
    defaultDirectory: '/default',
    defaultSessionId: 's1',
    send: async (text) => replies.push(text),
    createSessionPoller: (options) => {
      poller = { ...options, stop() {}, tick: () => options.onReply?.('Hello from OpenCode') };
      return poller;
    },
  });
  await handleWithPoller({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: 'hello' } });
  assert.equal(calls.prompt.at(-1).sessionID, 's1');
  poller.tick();
  assert.equal(replies.at(-1), 'Hello from OpenCode');
  assert.doesNotMatch(replies.join('\n'), /No session currently attached/);
});

test('promptAndWait returns streamed text instead of a timeout error when text exists', async () => {
  const { promptAndWait } = await import('../src/opencode.js');
  const errors = [];
  const client = {
    session: { prompt: async () => {} },
    event: {
      subscribe: () =>
        (async function* () {
          yield { type: 'server.connected', data: {} };
          yield {
            type: 'session.text.delta',
            data: { sessionID: 's9', assistantMessageID: 'a9', delta: 'Partial answer' },
          };
          await new Promise(() => {});
        })(),
    },
  };
  const answer = await promptAndWait(
    client,
    's9',
    'hi',
    () => {},
    (error) => errors.push(error),
    () => {},
    300,
  );
  assert.equal(answer, 'Partial answer');
  assert.deepEqual(errors, []);
});

test('!command runs directly and returns its output', async () => {
  const { replies, incoming } = setup();
  await incoming('!ls -la');
  assert.match(replies.at(-1).text, /\$ ls -la/);
  assert.match(replies.at(-1).text, /output of ls -la/);
});

test('!cd updates the working directory used by later shell commands', async () => {
  const { replies, incoming } = setup();
  await incoming('!cd /tmp');
  assert.match(replies.at(-1).text, /Working directory: \/tmp/);
  await incoming('!pwd');
  assert.match(replies.at(-1).text, /output of pwd/);
});

test('a normal message with no session sends the numbered session list', async () => {
  const { replies, incoming } = setup();
  await incoming('hello');
  const text = replies.at(-1).text;
  assert.match(text, /No session currently attached/);
  assert.match(text, /1\. Session One/);
  assert.match(text, /2\. Session Two/);
});

test('/session lists then /session 2 attaches', async () => {
  const { replies, incoming } = setup();
  await incoming('/session');
  assert.match(replies.at(-1).text, /1\. Session One/);
  await incoming('/session 2');
  assert.match(replies.at(-1).text, /Attached successfully to session 2: s2/);
});

test('prompt is enqueued and the poller delivers only the final answer', async () => {
  const ctx = setup();
  const { replies, calls, incoming } = ctx;
  await incoming('/session 1');
  await incoming('what is 2+2?');
  assert.equal(calls.prompt.at(-1).text, 'what is 2+2?');
  ctx.poller.tick();
  assert.equal(replies.at(-1).text, 'Hello from OpenCode');
  assert.ok(!replies.some((r) => /^thinking:/m.test(r.text ?? r)));
  assert.doesNotMatch(replies.at(-1).text, /calling tool|write_tool/);
});

test('/exit detaches and the next prompt asks for a session again', async () => {
  const { replies, incoming } = setup();
  await incoming('/session 1');
  await incoming('/exit');
  assert.equal(replies.at(-1).text, 'session exited');
  await incoming('another question');
  assert.match(replies.at(-1).text, /No session currently attached/);
});

test('/model ls lists models and /models 2 switches the attached session', async () => {
  const { replies, calls, incoming } = setup();
  await incoming('/model ls');
  assert.match(replies.at(-1).text, /1\. opencode\/m1/);
  await incoming('/session 1');
  await incoming('/models  2');
  assert.equal(calls.switchModel.at(-1).sessionID, 's1');
  assert.equal(calls.switchModel.at(-1).model.id, 'm2');
  assert.match(replies.at(-1).text, /anthropic\/m2/);
});

test('/models 1 with no session asks the user to connect first', async () => {
  const { replies, incoming } = setup();
  await incoming('/models 1');
  const text = replies.at(-1).text;
  assert.match(text, /No session attached|connect one first/);
  assert.match(text, /1\. Session One/);
});

test('/session new creates a session in the given directory and remembers the chosen model', async () => {
  const { replies, calls, incoming } = setup();
  await incoming('/session new /home/oryxa');
  assert.match(replies.at(-1).text, /Attached successfully to new session/);
  assert.equal(calls.create.at(-1).location.directory, '/home/oryxa');
  assert.ok(calls.create.at(-1).model, 'a default model was chosen');

  // Choose a model, exit, then create another session: it must reuse the last model.
  await incoming('/model ls');
  await incoming('/models 2');
  await incoming('/exit');
  await incoming('/session new /tmp');
  assert.equal(calls.create.at(-1).model.id, 'm2');
});

test('splitText chunks long replies and never returns an empty reply', () => {
  assert.deepEqual(splitText(''), ['(no output)']);
  const chunks = splitText('x'.repeat(3200), 1500);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 1500));
  assert.equal(chunks.join(''), 'x'.repeat(3200));
});

test('/help lists every command', async () => {  const { replies, incoming } = setup();
  await incoming('/help');
  const text = replies.at(-1).text;
  for (const cmd of ['/session', '/model', '/bash', '!<cmd>', '/allow', '/exit', '/help']) {
    assert.match(text, new RegExp(cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('voice attachment is transcribed and sent as a prompt', async () => {
  const replies = [];
  const prompts = [];
  const { client } = makeClient();
  client.session.prompt = async (input) => prompts.push(input);
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    transcribeVoice: async () => ({ transcript: 'do the thing', confidence: 0.99 }),
    saveImage: async () => ({ file: '/tmp/x.jpg', bytes: 100 }),
    createSessionPoller: () => ({ stop() {}, tick() {} }),
    defaultSessionId: 's1',
  });
  await handle({
    pageId: 'PAGE',
    customerInfo: { id: 'USER' },
    payload: { text: '[attachment:audio]', attachments: [{ type: 'audio', url: 'https://cdn/x.mp4' }] },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(replies.join('\n'), /transcribing voice/);
  assert.match(replies.join('\n'), /you said: do the thing/);
  assert.equal(prompts.at(-1)?.text, 'do the thing');
});

test('image attachment is saved and acknowledged without prompting', async () => {
  const replies = [];
  const prompts = [];
  const { client } = makeClient();
  client.session.prompt = async (input) => prompts.push(input);
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    transcribeVoice: async () => ({ transcript: 'x', confidence: 1 }),
    saveImage: async () => ({ file: '/tmp/x.jpg', bytes: 2048 }),
    createSessionPoller: () => ({ stop() {}, tick() {} }),
  });
  await handle({
    pageId: 'PAGE',
    customerInfo: { id: 'USER' },
    payload: { text: '[attachment:image]', attachments: [{ type: 'image', url: 'https://cdn/x.jpg' }] },
  });
  assert.match(replies.join('\n'), /image saved/);
  assert.equal(prompts.length, 0);
});

test('strangers are silently dropped when allowedIds is set', async () => {
  const replies = [];
  const prompts = [];
  const { client } = makeClient();
  client.session.prompt = async (input) => prompts.push(input);
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    allowedIds: ['USER'],
    createSessionPoller: () => ({ stop() {}, tick() {} }),
    defaultSessionId: 's1',
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'EVIL' }, payload: { text: 'hello' } });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: 'hi' } });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, 'hi');
  assert.ok(!replies.join('\n').includes('hello'));
});

test('/img sends an image by URL and validates input', async () => {
  const sent = [];
  const { client } = makeClient();
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async () => {},
    sendImage: async (url, event) => sent.push({ url, to: event?.customerInfo?.id }),
    createSessionPoller: () => ({ stop() {}, tick() {} }),
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/img https://cdn/x.png' } });
  assert.deepEqual(sent, [{ url: 'https://cdn/x.png', to: 'USER' }]);
  const replies = [];
  const handle2 = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createSessionPoller: () => ({ stop() {}, tick() {} }),
  });
  await handle2({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/img not-a-url' } });
  assert.match(replies.at(-1), /Usage: \/img/);
});

test('/compact compacts the attached session', async () => {
  const replies = [];
  const { client, calls } = makeClient();
  calls.compact = [];
  client.session.compact = async (input) => calls.compact.push(input);
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createSessionPoller: () => ({ stop() {}, tick() {} }),
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/compact' } });
  assert.match(replies.at(-1), /No active session/);
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/compact' } });
  assert.deepEqual(calls.compact, [{ sessionID: 's1' }]);
  assert.match(replies.at(-1), /session compacted/);
});

test('/models switch applies OPENCODE_MODEL_VARIANT', async () => {
  process.env.OPENCODE_MODEL_VARIANT = 'xhigh';
  try {
    const { incoming, calls } = setup();
    await incoming('/session 1');
    await incoming('/models 2');
    assert.equal(calls.switchModel.at(-1).model.variant, 'xhigh');
  } finally {
    delete process.env.OPENCODE_MODEL_VARIANT;
  }
});

test('/status shows session, working time and token totals', async () => {
  const { incoming, replies } = setup({ active: true });
  await incoming('/session 1');
  await incoming('/status');
  const text = replies.at(-1).text;
  assert.match(text, /Status: Session One/);
  assert.match(text, /working for/);
  assert.match(text, /tokens: 0 in \/ 0 out/);
});
