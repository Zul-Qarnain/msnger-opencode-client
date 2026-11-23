# Messager OpenCode Client

A Node.js control panel that turns a **Facebook Messenger thread** into a remote console for the
local [OpenCode](https://opencode.ai) service. It uses the **OnlyOrders external-service API** for
messaging, so no Facebook Graph credentials live in this repo.

Messenger message → OnlyOrders webhook → Cloudflare tunnel → this server → OpenCode SDK →
Messenger reply.

## Features

- **Shell escape hatch:** any message starting with `!` runs locally (`!ls`, `!cd /tmp`, …) and the output is sent back.
- **Stateful terminal:** `/bash` opens a persistent shell at `/home`; later messages are commands, state (cwd/exports) persists, and continuous output is streamed.
- **Session control:** list, attach, create and detach OpenCode sessions from Messenger. The service
  creates its **own dedicated session** on first start (`botSessionId` in `db.json`), so prompts
  never loop back into the session currently running the service/agent.
- **Model control:** list connected models and switch the attached session's model.
- **Polling output:** after attaching a session the bot polls its messages every 3 s (`MSGCTRL_POLL_MS` overrides it). Output from prompts sent through the bot **and** from turns already running when you attached is delivered by the same poller. It stops on `/exit`, a new attach, or `/bash`.
- **Errors & permissions:** OpenCode failures and permission requests are forwarded; permissions can be answered from Messenger.
- **Attachment summary:** attaching a session sends a confirmation, the active model and the last 3 turns (user + final reply only).
- **Self-healing tunnel:** a Cloudflare quick tunnel is started on every run, the OnlyOrders webhook is re-pointed automatically, and restarts are logged.

## Architecture

```
 Messenger (OryzaAdmin Page)
        │  message
        ▼
 OnlyOrders external service  ──webhook POST──▶  https://<random>.trycloudflare.com/webhook
   /api2/ext-service/:id/...                              │
        │  SendMessage / SendMessageSeenReq / ...         │ local port 8788
        └───────────────────────────────────────────────  ▼
                                                   msgctrl service (Node)
                                                   ├─ HTTP receiver (/webhook, /facebook-selected)
                                                   ├─ commands.js  (command router)
                                                   ├─ opencode.js  (@opencode/client)
                                                   └─ tunnel.js    (cloudflared lifecycle)
                                                            │
                                                            ▼
                                                   OpenCode service (127.0.0.1:49374)
```

The server does **not** talk to Facebook directly. Sending text uses OnlyOrders'
`POST /ext-service/:id/SendMessage`; the Page token stays on the OnlyOrders side.

## Requirements

- **Node.js 22+** (tested on Node v24 from nvm)
- **`cloudflared`** installed and on `PATH` (Cloudflare quick tunnels)
- **`opencode` CLI v2** installed and on `PATH` (the client connects to its background service)
- An OnlyOrders external service with a connected Facebook Page (created by `msgctrl init`)
- Optionally **passwordless `sudo`** for full one-shot setup and cloudflared installation (the CLI never prompts for a password)

On this machine the working toolchain is:

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$HOME/.opencode/bin:$PATH"
```

## Install

```sh
cd /home/ubuntu/messager_opencode_client
npm install
npm link          # installs the global `msgctrl` command
msgctrl check     # verifies binaries, runtime endpoint and systemd units
```

`msgctrl check` reports:

```
cloudflared binary: /usr/local/bin/cloudflared
opencode binary:    /home/ubuntu/.opencode/bin/opencode
opencode runtime:   http://127.0.0.1:49374
systemd available:  system=true user=false
opencode systemd:  active (system, opencode-server.service)
cloudflared systemd: active (system, cloudflared-quick.service)
msgctrl systemd:   system:not-found, user:not-found
```

It finds binaries even when they are outside `PATH`, reads the live OpenCode endpoint from
`opencode service status`, and checks both system and user systemd scopes. `msgctrl init` runs the
same preflight and warns when OpenCode is reachable but has no systemd unit (it could stop on
reboot). The system `cloudflared-quick.service`/`opencode-server.service` pair (if present) may be
pointed at another local port; `msgctrl` always starts **its own** quick tunnel to its own HTTP
receiver (`PORT`, default 8788), so the two do not conflict.

## First-time setup: `msgctrl init`

```sh
msgctrl init
```

Interactive flow:

1. Checks `opencode` (version + path) and `cloudflared` (version + path). If either is missing it asks whether to install it; if OpenCode is older than v2 it asks whether to upgrade. Installers use the [official OpenCode v2 install script](https://opencode.ai/v2/install) and the [official cloudflared release binary](https://developers.cloudflare.com/tunnel/downloads/), then put them on `PATH` (systemd units set their own `PATH` explicitly). Declining leaves the tool untouched and aborts with a clear error.
2. Asks for a **service name**.
3. Starts a Cloudflare quick tunnel and waits for its public URL.
4. Calls `/create` on OnlyOrders to create the external service.
5. Registers `<tunnel>/webhook` and stores the webhook UUID.
6. Calls `/getFacebookConnectOauthUrl` with `<tunnel>/facebook-selected` as the redirect, then prints the Facebook login URL.
7. **You open that URL in a browser and select Page(s).** OnlyOrders posts the selection to the tunnel; the local receiver stores it.
8. The CLI prints the selected Pages with numbers and asks which one becomes the control panel.
9. Choosing a number calls `/connectChannel` for that Page (this subscribes the Page's webhook, so OnlyOrders starts forwarding its messages) and stores `pageId`.
10. Uses `sudo -n` to install, enable and **start** three systemd units (see below). If passwordless sudo is unavailable, it falls back to writing a user unit and prints the manual commands.

Nothing is sent to your external redirect except the Page **name** and **id** — no tokens.

### System services installed by `init`

With passwordless sudo, `init` installs and enables these system units immediately:

| Unit | Purpose |
|---|---|
| `opencode-server.service` | OpenCode server. Reused if already active; otherwise created from the discovered CLI/endpoint. |
| `msgctrl-tunnel.service` | Dedicated `cloudflared` quick tunnel to local port 8788. Appends its output to `msgctrl-tunnel.log`. |
| `msgctrl.service` | Runs `msgctrl start`, reads the tunnel URL from the log, PUTs the webhook, and serves Messenger traffic. |

All three are `enabled` (start at boot) and `Restart=always`. `msgctrl.service` runs with
`MSGCTRL_EXTERNAL_TUNNEL=1`, so it does **not** spawn its own cloudflared child — it watches the
tunnel unit's log. When the quick-tunnel URL changes after a restart, the newest URL is detected and
the OnlyOrders webhook is re-pointed using the stored webhook id.

Without sudo, `init` falls back to a user unit and prints the manual `systemctl` commands.

## Running

```sh
msgctrl start     # foreground; used by systemd on boot
msgctrl status    # stored ids, tunnel URL and last log entries
msgctrl install   # (re)write the systemd user unit
msgctrl uninstall # remove it
```

`msgctrl init` already enables and starts the units. If sudo was unavailable, enable manually:

```sh
systemctl --user enable --now msgctrl
# or, after `sudo msgctrl install --system`:
sudo systemctl enable --now msgctrl msgctrl-tunnel.service
```

Health check: `curl http://localhost:8788/health`

### What happens on every start

1. `db.json` is read for `serviceId`, `webhookId`, and `pageId`.
2. The local HTTP receiver binds first (so a port conflict fails fast).
3. `cloudflared tunnel --url http://localhost:8788` starts; the public URL is parsed from its output.
4. `PUT /ext-service/:id/webhook/:webhookId` updates the webhook URL to the **new** tunnel URL.
5. `state.json` records `tunnelUrl`, `webhookUrl`, `webhookUpdatedAt`, and appends log entries.
6. If cloudflared exits, it is restarted with backoff and the webhook is re-pointed again.

## Persistent files

| File | Contents | Protection |
|---|---|---|
| `db.json` | `serviceId`, `serviceName`, `webhookId`, `webhookUrl`, `pageId`, `pageName`, `channelId`, `defaultDirectory`, `defaultModel` | gitignored, `0600` |
| `state.json` | `tunnelUrl`, `webhookUrl`, `webhookUpdatedAt`, `selectedPages`, last 200 log entries | gitignored, `0600` |
| `~/.config/systemd/user/msgctrl.service` | systemd unit with `Restart=always` | user-managed |
| `msgctrl.log` | stdout/stderr when run under systemd | gitignored |

## Messenger command reference

| Message | Action |
|---|---|
| `/help` | Show this command list |
| `/img <url>` | Send an image by public URL |
| voice note (audio attachment) | Transcribed via Deepgram Nova-3, transcript sent as the prompt |
| photo (image attachment) | Saved to `media/`, acknowledged (vision piping is future work) |
|---|---|
| `/bash` | Open a stateful terminal at `/home` (see below) |
| `!ls`, `!pwd`, `!cd /tmp` | Run a shell command; output is sent back. `!cd` changes the working directory for later `!` commands. |
| `/session` | List OpenCode sessions with numbers |
| `/session 2` | Attach to session 2; checks whether it is busy, replies with confirmation/model/history and either “no operation currently running” or a live report of the running turn |
| `/session new /home/oryxa` | Create and attach a session in that directory |
| `/session pwd` | Show active session title/id, directory and model |
| `/exit` | Detach from the current session |
| `/model ls` | List connected chat models with numbers |
| `/models 2` | Switch the attached session to model 2 |
| `/model pwd` | Show the active model and attached session |
| `/compact` | Compact the attached session to free context |
| `/status` | Working time, current-turn progress, token usage (k/M) |
| `/allow <id>` / `/always <id>` / `/reject <id>` | Answer a forwarded OpenCode permission request |
| anything else | Prompt for the attached session; if none is attached, you get the session list |

### Polling output model

The bot no longer subscribes to OpenCode's live event stream for output. When you attach to a
session it starts a polling worker that calls `GET /session/:id/message` every 3 seconds, filters
messages created after the attach time, and forwards:

- completed `text` parts **once** when the assistant message is complete (no partial/duplicate replies),
- assistant errors as `error [poll]: ...`,
- pending permission requests, which can be answered with `/allow`, `/always`, `/reject`.

Thinking output is never forwarded — only the final answer is delivered. Tool-call chatter is never sent.

This means it also reports output from work that was already running before you attached, and
prompts only enqueue work — the poller owns all reporting until `/exit`, another attach, or `/bash`.

### Terminal mode (`/bash`)

`/bash` spawns one persistent bash process for that Messenger user, starting at `/home`:

- `cd /sbin` changes the directory; the next `pwd`/`ls` runs in `/sbin`. Shell state (exports, etc.) survives too.
- Fast commands (`cat`, `ls`, `pwd`) are buffered and delivered as **one complete reply**; long-running commands (`tail -f`, a server, a loop) switch to streaming after ~800 ms and then keep reporting line by line.
- `exit` typed in the terminal or `/exit` from Messenger closes it; the bot replies `terminal exited (code 0)` or `terminal closed`.
- After closing, normal behavior resumes: attached sessions receive prompts, otherwise you get the session list.

`!` commands remain one-off commands that do not open terminal mode.

### Output behavior

- **Thinking:** never forwarded to Messenger — only the final answer is delivered. Tool-call chatter is never sent.
- **Final reply:** always sent after the turn finishes, even if a tool step failed.
- **Errors:** forwarded as `error [type]: message`, deduplicated per message.
- **Permissions:** forwarded with id/action/resources and reply instructions.
- **History on attach:** last 3 turns, separated by `#############`, user messages + final assistant text only (no reasoning, no tool calls).
- **Attaching to a busy session:** the bot checks `session.active` first. If idle, it says so. If a turn is running, it says “Operation running and reporting from now” and opens a **live** listener from that moment — no replay of earlier tokens. From then on it uses the same thinking relay and sends the final reply when the turn ends. A new prompt or `/exit` supersedes that listener.

## OnlyOrders API endpoints used

| Endpoint | Purpose |
|---|---|
| `POST /ext-service/create` | Create the service during init |
| `POST /ext-service/:id/webhook` | Register webhook |
| `PUT /ext-service/:id/webhook/:webhookId` | Re-point webhook on restart |
| `POST /ext-service/getFacebookConnectOauthUrl` | Build the Facebook connect URL |
| `POST /ext-service/:id/connectChannel` | Bank Page tokens, subscribe Page webhook, store channel |
| `POST /ext-service/:id/SendMessage` | Send text reply |
| `POST /ext-service/:id/SendMessageSeenReq` / `SendMessageTypingReq` | Seen / typing indicators (available via the API; not auto-sent) |
| `POST /ext-service/:id/sendCommentReply` | Available for comment replies (not auto-sent) |

Base URL is `https://onlyorders.tech/api2/ext-service` (override with `ONLYORDERS_API_BASE`).

## Project layout

```
bin/msgctrl          CLI entrypoint (init/start/status/install/uninstall/check)
src/config.js        db.json / state.json read/write, append-only log
src/tunnel.js        cloudflared quick-tunnel lifecycle + URL parsing
src/onlyorders.js    thin OnlyOrders API client
src/opencode.js      @opencode/client wrapper, history, prompt/stream handling
src/commands.js      Messenger command router
src/init.js          interactive setup flow
src/server.js        shared HTTP receiver + long-running runtime
src/systemd.js       systemd user-unit generation/install
test/                node:test suites (commands + core/config/init)
```

## Reliability

- **Messenger send failures are non-fatal.** If OnlyOrders/Meta rejects a reply (for example
  `graph_send_failed 100:2018034`), the error is logged as `reply-error` in `state.json` and the
  webhook receiver keeps running.
- **Long turns won't produce a bare timeout.** The wait is 10 minutes by default
  (`MSGCTRL_TIMEOUT_MS` overrides it), and if text has already been streamed when the wait expires
  that text is delivered as the reply instead of an error.
- **Tunnel failures are non-fatal.** A dead cloudflared process is restarted with backoff and the
  webhook URL is re-synced; the event is logged.
- **One webhook only.** `msgctrl` always PUTs the stored webhook id instead of creating a new one,
  so restarts and `GET /register` never leave duplicate webhooks that multiply replies.
- **Prompts are serialized** per Messenger user, so two fast messages cannot produce mixed replies.
- **State is observable.** `msgctrl status` shows the last log entries from `state.json`.

## Tests

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$HOME/.opencode/bin:$PATH"
npm test
```

33 tests cover command routing, history sorting, thinking relay, error forwarding, permission
handling, config persistence, tunnel parsing (including watching a service log across restarts),
systemd unit generation, service detection, dependency version/install checks, the stateful
terminal (buffering + streaming), busy-session attach reporting, dedicated-session defaults,
partial-timeout handling, the 3-second polling worker, the callback receiver, and the full injected
init flow. No live Messenger or OnlyOrders account is needed.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `cloudflared: missing` | Install cloudflared and re-run `msgctrl check` |
| `opencode: missing` | Install opencode CLI v2, start its service, re-run `msgctrl check` |
| `EADDRINUSE :8788` | Another msgctrl/node process is using the port; stop it with `pkill -f 'msgctrl start'` |
| No reply to a prompt | Check `state.json` logs and `msgctrl status`; ensure `pageId` is in `db.json` and the webhook is the only live one |
| `reply-error` / send 500 | OnlyOrders/Meta refused the send; the service stays up. Recheck the recipient/page and retry later |
| Duplicate replies | Verify only one live webhook exists for the service; `msgctrl start` always PUTs the same stored webhook id |
| Webhook stopped after restart | `state.json` should show a fresh `webhookUpdatedAt`; if not, re-run `msgctrl start` |
| systemd unit not active | Run `systemctl --user daemon-reload && systemctl --user enable --now msgctrl` |

## Security

- `!` commands execute arbitrary shell commands with your user's privileges. Only give the connected
  Facebook Page to people you trust. This is a remote-control surface by design.
- `db.json` and `state.json` contain identifiers only — no Page access tokens. They are still
  written with `0600` and gitignored.
- No secrets are required in this repo. If a GitHub token or API key is ever pasted into chat, rotate it.
