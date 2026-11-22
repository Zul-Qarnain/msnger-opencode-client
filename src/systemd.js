import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { homeDir } from './config.js';

const SYSTEM_DIR = '/etc/systemd/system';

const run = (cmd, args) => {
  try {
    const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 });
    return {
      ok: result.status === 0,
      stdout: (result.stdout ?? '').trim(),
      stderr: (result.stderr ?? '').trim(),
      error: result.error?.message ?? null,
    };
  } catch (err) {
    return { ok: false, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) };
  }
};

export function sudoAvailable() {
  return run('sudo', ['-n', 'true']).ok;
}

export function unitActive(unit) {
  return run('systemctl', ['is-active', unit]).stdout === 'active';
}

export function unitEnabled(unit) {
  return run('systemctl', ['is-enabled', unit]).stdout;
}

function detectedPath(nodeBin, extraBins = []) {
  const parts = [path.dirname(nodeBin)];
  for (const binary of extraBins) {
    const found = run('which', [binary]);
    if (found.ok && found.stdout) parts.push(path.dirname(found.stdout.split('\n')[0]));
  }
  return [...new Set([...parts, '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
}

/** Writes a unit with sudo and enables/starts it. No password prompt is ever issued. */
function installSystemUnit(name, content) {
  if (!sudoAvailable()) {
    return { ok: false, error: 'passwordless sudo is unavailable' };
  }
  const tmp = path.join(os.tmpdir(), `msgctrl-${name}-${process.pid}`);
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  try {
    const copied = run('sudo', ['-n', 'install', '-m', '644', tmp, path.join(SYSTEM_DIR, name)]);
    if (!copied.ok) return { ok: false, error: copied.stderr || copied.error };
    const reloaded = run('sudo', ['-n', 'systemctl', 'daemon-reload']);
    if (!reloaded.ok) return { ok: false, error: reloaded.stderr || reloaded.error };
    const enabled = run('sudo', ['-n', 'systemctl', 'enable', '--now', name]);
    return {
      ok: enabled.ok,
      name,
      error: enabled.ok ? null : (enabled.stderr || enabled.error),
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

export function msgctrlUnitContent({
  user,
  workdir,
  nodeBin,
  port = 8788,
  defaultDirectory = workdir,
  tunnelLogPath,
}) {
  const home = process.env.HOME ?? '/home/ubuntu';
  return `[Unit]
Description=Messenger OpenCode control panel
Wants=network-online.target msgctrl-tunnel.service
After=network-online.target msgctrl-tunnel.service

[Service]
Type=simple
User=${user}
Environment=HOME=${home}
WorkingDirectory=${workdir}
Environment=PATH=${detectedPath(nodeBin, ['opencode', 'cloudflared'])}
Environment=PORT=${port}
Environment=DEFAULT_DIRECTORY=${defaultDirectory}
Environment=OPENCODE_MODEL=${process.env.OPENCODE_MODEL ?? 'opencode/hy4-flash-free'}
Environment=MSGCTRL_EXTERNAL_TUNNEL=1
Environment=MSGCTRL_TUNNEL_LOG=${tunnelLogPath}
EnvironmentFile=-${path.join(workdir, '.env')}
ExecStart=${nodeBin} ${path.join(workdir, 'bin', 'msgctrl')} start
Restart=always
RestartSec=5
StandardOutput=append:${path.join(homeDir(), 'msgctrl.log')}
StandardError=append:${path.join(homeDir(), 'msgctrl.log')}

[Install]
WantedBy=multi-user.target
`;
}

export function opencodeUnitContent({ user, binary, port = 4096 }) {
  const home = process.env.HOME ?? '/home/ubuntu';
  return `[Unit]
Description=OpenCode service (managed by msgctrl)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
Environment=HOME=${home}
WorkingDirectory=${home}
ExecStart=${binary} serve --hostname 127.0.0.1 --port ${port}
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
`;
}

export function tunnelUnitContent({ user, binary, port = 8788, logPath, tunnelConfigFile = null }) {
  const home = process.env.HOME ?? '/home/ubuntu';
  // Named tunnel (permanent domain): route comes from the local config file.
  // Quick tunnel otherwise (ephemeral URL).
  const command = tunnelConfigFile
    ? `${binary} tunnel --no-autoupdate --config ${tunnelConfigFile} run 2>&1 | tee -a ${logPath}`
    : `${binary} tunnel --no-autoupdate --url http://127.0.0.1:${port} 2>&1 | tee -a ${logPath}`;
  return `[Unit]
Description=Cloudflare quick tunnel for msgctrl webhook receiver
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
Environment=HOME=${home}
ExecStart=/bin/bash -c ${JSON.stringify(command)}
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
`;
}

/** Ensures OpenCode is running under systemd, creating a unit only when none is active. */
export function ensureOpencodeService({ user, binary, runtimeUrl } = {}) {
  if (unitActive('opencode-server.service') || unitActive('msgctrl-opencode.service')) {
    return { ok: true, unit: 'already-active', started: false };
  }
  if (!binary) return { ok: false, error: 'opencode binary not found' };

  // Prefer an existing installed unit over creating a competing one.
  const existing = unitEnabled('opencode-server.service');
  if (existing && existing !== 'not-found') {
    const enabled = run('sudo', ['-n', 'systemctl', 'enable', '--now', 'opencode-server.service']);
    return { ok: enabled.ok, unit: 'opencode-server.service', error: enabled.stderr || null };
  }

  const port = Number(runtimeUrl?.match(/:(\d+)(?:\/|$)/)?.[1] ?? 4096);
  return installSystemUnit(
    'msgctrl-opencode.service',
    opencodeUnitContent({ user, binary, port }),
  );
}

/** Ensures a dedicated cloudflared unit exists for the msgctrl receiver. */
export function ensureTunnelService({ user, binary, port = 8788, logPath } = {}) {
  if (unitActive('msgctrl-tunnel.service')) {
    return { ok: true, unit: 'msgctrl-tunnel.service', started: false };
  }
  if (!binary) return { ok: false, error: 'cloudflared binary not found' };
  return installSystemUnit(
    'msgctrl-tunnel.service',
    tunnelUnitContent({ user, binary, port, logPath }),
  );
}

/** Installs, enables and starts the msgctrl service system-wide. */
export function ensureMsgctrlService(options = {}) {
  return installSystemUnit('msgctrl.service', msgctrlUnitContent(options));
}

/**
 * One-shot setup used by `msgctrl init`. Installs all three units with sudo (when available).
 */
export function bootstrapSystemServices({
  user = process.env.USER ?? 'ubuntu',
  workdir = process.cwd(),
  nodeBin = process.execPath,
  port = 8788,
  defaultDirectory = workdir,
  tunnelLogPath = path.join(homeDir(), 'msgctrl-tunnel.log'),
  opencodeBinary,
  cloudflaredBinary,
  runtimeUrl,
} = {}) {
  const canSudo = sudoAvailable();
  if (!canSudo) {
    const fallback = installUnitFallback({ user, workdir, nodeBin, port, defaultDirectory });
    return {
      sudo: false,
      fallback,
      opencode: { ok: false, error: 'sudo unavailable' },
      tunnel: { ok: false, error: 'sudo unavailable' },
      msgctrl: { ok: false, error: 'sudo unavailable' },
    };
  }

  const opencode = ensureOpencodeService({ user, binary: opencodeBinary, runtimeUrl });
  const tunnel = ensureTunnelService({ user, binary: cloudflaredBinary, port, logPath: tunnelLogPath });
  const msgctrl = ensureMsgctrlService({
    user,
    workdir,
    nodeBin,
    port,
    defaultDirectory,
    tunnelLogPath,
  });
  return { sudo: true, opencode, tunnel, msgctrl };
}

/** Legacy user-unit writer (no sudo). Kept for `msgctrl install`/`uninstall`. */
export function installUnit({ user, workdir, nodeBin, port, defaultDirectory, system = false } = {}) {
  if (system) {
    return installSystemUnit(
      'msgctrl.service',
      msgctrlUnitContent({
        user,
        workdir,
        nodeBin,
        port,
        defaultDirectory: defaultDirectory ?? workdir,
        tunnelLogPath: path.join(homeDir(), 'msgctrl-tunnel.log'),
      }),
    );
  }
  const targetDir = path.join(process.env.HOME ?? '/root', '.config', 'systemd', 'user');
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, 'msgctrl.service');
  fs.writeFileSync(
    target,
    msgctrlUnitContent({
      user,
      workdir,
      nodeBin,
      port,
      defaultDirectory: defaultDirectory ?? workdir,
      tunnelLogPath: path.join(homeDir(), 'msgctrl-tunnel.log'),
    }),
    { mode: 0o644 },
  );
  const reloaded = run('systemctl', ['--user', 'daemon-reload']);
  return { path: target, reloaded: reloaded.ok, error: reloaded.error };
}

function installUnitFallback(options) {
  try {
    return installUnit(options);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function uninstallUnit({ system = false } = {}) {
  const names = system
    ? ['msgctrl.service', 'msgctrl-tunnel.service']
    : ['msgctrl.service'];
  for (const name of names) {
    const target = system
      ? path.join(SYSTEM_DIR, name)
      : path.join(process.env.HOME ?? '/root', '.config', 'systemd', 'user', name);
    if (system && sudoAvailable()) {
      run('sudo', ['-n', 'systemctl', 'disable', '--now', name]);
      run('sudo', ['-n', 'rm', '-f', target]);
      run('sudo', ['-n', 'systemctl', 'daemon-reload']);
    } else {
      try { fs.unlinkSync(target); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      run('systemctl', ['--user', 'daemon-reload']);
    }
  }
  return { removed: names };
}
