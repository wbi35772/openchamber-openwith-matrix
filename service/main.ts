/**
 * OpenChamber OpenWith Matrix — local service.
 *
 * Runs as a child process of the OpenChamber host (`contributes.service`).
 * The panel is a sandboxed iframe, so every privileged action (files, shells,
 * Docker, kubectl, Chrome, guest proxies) happens here and is reached through
 * `host.serviceRequest`.
 *
 * Protocol: the host passes OPENCHAMBER_SERVICE_PORT and
 * OPENCHAMBER_SERVICE_TOKEN; every request needs `Authorization: Bearer <token>`.
 * The listener binds 127.0.0.1 only.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { CONFIG_PATH, ConfigStore } from './configStore.ts';
import { DockerController } from './dockerController.ts';
import { GuestManager } from './guestManager.ts';
import { HostLauncher } from './hostLauncher.ts';
import { K8sController } from './k8sController.ts';
import { LogController } from './logController.ts';
import { log } from './logger.ts';
import { BrowserController } from './webProxy.ts';
import { ShardxController } from './shardxController.ts';
import { TerminalController } from './terminalController.ts';
import { createVariableContext, expandRecord, expandTemplate } from './variableEngine.ts';
import { WslController } from './wslController.ts';

import {
  MATRIX_VERSION,
  type BrowserInput,
  type GuestServiceRequest,
  type MatrixConfig,
  type MatrixHealth,
  type MatrixSnapshot,
  type WebhookResult,
} from '../shared/types.ts';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
const STARTED_AT = Date.now();
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PICKER_TTL_MS = 5 * 60 * 1000;

interface PickerSession {
  file: string;
  child: ChildProcess;
  startedAt: number;
}

const pickers = new Map<string, PickerSession>();

const OS =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

if (!PORT || !TOKEN) {
  log('missing OPENCHAMBER_SERVICE_PORT or OPENCHAMBER_SERVICE_TOKEN');
  process.exit(1);
}

const configStore = new ConfigStore();
const launcher = new HostLauncher();
const docker = new DockerController();
const k8s = new K8sController();
const wsl = new WslController();
const shardx = new ShardxController();
const guests = new GuestManager(log);
const terminal = new TerminalController(
  () => configStore.get().settings.terminalShell,
  () => configStore.get().settings.wsl.distro,
);
const logs = new LogController(() => configStore.get());
const browser = new BrowserController(() => configStore.get().settings.browser);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const send = (res: http.ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};

const readJson = async (req: http.IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body-too-large');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid-json');
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const asNumber = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const health = (): MatrixHealth => ({
  status: 'ok',
  version: MATRIX_VERSION,
  pid: process.pid,
  uptimeMs: Date.now() - STARTED_AT,
});

const snapshot = async (): Promise<MatrixSnapshot> => {
  const config = configStore.get();
  const errors: string[] = [];
  const settle = async <T>(label: string, work: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work;
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  };

  const [guestList, apps, shardxSnapshot, wslSnapshot, dockerSnapshot, k8sSnapshot] =
    await Promise.all([
      settle('guests', guests.list(), []),
      settle('apps', launcher.detect(), []),
      settle(
        'shardx',
        shardx.snapshot(config.settings.shardx, config.groups.win11.shardx),
        {
          online: false,
          apiBase: config.settings.shardx.apiBase,
          profiles: [],
          running: [],
          instances: [],
          expected: config.settings.shardx.profileCount,
          error: 'unavailable',
        },
      ),
      settle('wsl', wsl.snapshot(config.settings.wsl, config.groups.wsl.ports), {
        available: false,
        distros: [],
        ports: [],
        error: 'unavailable',
      }),
      settle('docker', docker.snapshot(), {
        available: false,
        containers: [],
        error: 'unavailable',
      }),
      settle('k8s', k8s.snapshot(config.settings.k8s), {
        available: false,
        contexts: [],
        pods: [],
        forwards: [],
        error: 'unavailable',
      }),
    ]);

  return {
    health: health(),
    config,
    guests: guestList,
    apps,
    shardx: shardxSnapshot,
    wsl: wslSnapshot,
    docker: dockerSnapshot,
    k8s: k8sSnapshot,
    errors,
  };
};

const findWebhook = (id: string) =>
  configStore.get().groups.cloud.webhooks.find((webhook) => webhook.id === id) ?? null;

const runWebhook = async (id: string, directory: string): Promise<WebhookResult> => {
  const webhook = findWebhook(id);
  if (!webhook) throw new HttpError(404, 'webhook-not-found');
  const config = configStore.get();
  const context = await createVariableContext({ path: directory }, config);
  const url = expandTemplate(webhook.url, context);
  const headers = webhook.headers ? expandRecord(webhook.headers, context) : {};
  const body = webhook.body ? expandTemplate(webhook.body, context) : undefined;
  try {
    const response = await fetch(url, {
      method: webhook.method,
      headers,
      ...(body !== undefined && webhook.method !== 'GET' ? { body } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, url, body: text.slice(0, 64_000) };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url,
      body: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    send(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const parts = url.pathname
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => decodeURIComponent(part));
  const [root, second, third, fourth] = parts;

  if (method === 'GET' && parts.length === 1 && root === 'health') {
    send(res, 200, { ...health(), ok: true });
    return;
  }

  if (root === 'config') {
    if (method === 'GET' && parts.length === 1) {
      send(res, 200, { ok: true, data: configStore.get(), path: CONFIG_PATH });
      return;
    }
    if (method === 'PUT' && parts.length === 1) {
      const config = await configStore.save(await readJson(req));
      launcher.setApps(config.groups.win11.apps);
      send(res, 200, { ok: true, data: config });
      return;
    }
    if (method === 'POST' && second === 'reset') {
      const config = await configStore.reset();
      launcher.setApps(config.groups.win11.apps);
      send(res, 200, { ok: true, data: config });
      return;
    }
  }

  if (method === 'GET' && root === 'snapshot' && parts.length === 1) {
    send(res, 200, { ok: true, data: await snapshot() });
    return;
  }

  if (root === 'guests') {
    if (method === 'GET' && parts.length === 1) {
      send(res, 200, { ok: true, data: await guests.list() });
      return;
    }
    if (second && method === 'POST' && third === 'frame-grant') {
      const entry = asString(asRecord(await readJson(req)).entry, 'panel/index.html');
      send(res, 200, { ok: true, data: await guests.frameGrant(second, entry) });
      return;
    }
    if (second && method === 'POST' && third === 'service-request') {
      const body = asRecord(await readJson(req));
      const request = body as unknown as GuestServiceRequest;
      send(res, 200, { ok: true, data: await guests.serviceRequest(second, request) });
      return;
    }
    if (second && method === 'PUT' && third === 'enabled') {
      const enabled = asRecord(await readJson(req)).enabled === true;
      await guests.setEnabled(second, enabled);
      send(res, 200, { ok: true, data: { id: second, enabled } });
      return;
    }
    if (second && method === 'POST' && third === 'storage') {
      send(res, 200, { ok: true, data: await guests.storage(second, await readJson(req)) });
      return;
    }
  }

  if (root === 'apps') {
    if (method === 'GET' && parts.length === 1) {
      const apps = await launcher.detect(url.searchParams.get('refresh') === '1');
      const installed: Record<string, boolean> = {};
      for (const app of apps) installed[app.id] = app.installed;
      send(res, 200, { ok: true, os: OS, installed, apps, at: Date.now() });
      return;
    }
    if (second && method === 'POST' && third === 'open') {
      const body = asRecord(await readJson(req));
      const directory = asString(body.directory);
      if (!path.isAbsolute(directory)) throw new HttpError(400, 'directory-must-be-absolute');
      const result = await launcher.open(second, directory);
      send(res, result.ok ? 200 : 400, result);
      return;
    }
  }

  if (root === 'pick-file' && OS !== 'windows') {
    throw new HttpError(400, 'pick-file-windows-only');
  }

  if (method === 'POST' && root === 'pick-file' && parts[1] === 'start') {
    const body = asRecord(await readJson(req));
    const title = asString(body.title, '选择可执行文件');
    const filter = asString(
      body.filter,
      '可执行文件 (*.exe;*.cmd;*.bat)|*.exe;*.cmd;*.bat|所有文件 (*.*)|*.*',
    );
    const token = randomUUID();
    const file = path.join(os.tmpdir(), `openwith-picker-${token}.txt`);
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      `$out = '${file.replace(/'/g, "''")}'`,
      'Remove-Item -LiteralPath $out -ErrorAction SilentlyContinue',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      `$d.Title = '${title.replace(/'/g, "''")}'`,
      `$d.Filter = '${filter.replace(/'/g, "''")}'`,
      '$d.CheckFileExists = $true',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [IO.File]::WriteAllText($out, $d.FileName, [Text.Encoding]::UTF8) } else { [IO.File]::WriteAllText($out, "", [Text.Encoding]::UTF8) }',
    ].join('; ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
      windowsHide: false,
      stdio: 'ignore',
    });
    pickers.set(token, { file, child, startedAt: Date.now() });
    send(res, 200, { ok: true, data: { token } });
    return;
  }

  if (method === 'GET' && root === 'pick-file' && parts[1] === 'result') {
    const token = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token') ?? '';
    const session = pickers.get(token);
    if (!session) throw new HttpError(404, 'picker-not-found');
    if (Date.now() - session.startedAt > PICKER_TTL_MS) {
      session.child.kill();
      pickers.delete(token);
      await fsp.rm(session.file, { force: true });
      throw new HttpError(410, 'picker-expired');
    }
    try {
      const picked = await fsp.readFile(session.file, 'utf8');
      await fsp.rm(session.file, { force: true });
      pickers.delete(token);
      send(res, 200, { ok: true, data: { pending: false, path: picked.trim() || null } });
      return;
    } catch {
      /* not written yet: the dialog is still open */
    }
    if (session.child.exitCode !== null || session.child.killed) {
      pickers.delete(token);
      send(res, 200, { ok: true, data: { pending: false, path: null, closed: true } });
      return;
    }
    send(res, 200, { ok: true, data: { pending: true } });
    return;
  }

  if (method === 'POST' && root === 'open' && parts.length === 1) {
    const body = asRecord(await readJson(req));
    const directory = asString(body.directory);
    const app = asString(body.app);
    if (!path.isAbsolute(directory)) throw new HttpError(400, 'directory-must-be-absolute');
    if (!app) throw new HttpError(400, 'missing-app');
    const result = await launcher.open(app, directory);
    send(res, result.ok ? 200 : 400, result);
    return;
  }

  if (root === 'shardx') {
    const config = configStore.get();
    if (method === 'GET' && parts.length === 1) {
      send(res, 200, {
        ok: true,
        data: await shardx.snapshot(config.settings.shardx, config.groups.win11.shardx),
      });
      return;
    }
    if (method === 'POST' && second === 'launch' && parts.length === 2) {
      send(res, 200, { ok: true, data: await shardx.launch(config.settings.shardx) });
      return;
    }
    if (second && method === 'POST' && (third === 'start' || third === 'stop')) {
      const result =
        third === 'start'
          ? await shardx.start(
              config.settings.shardx,
              config.groups.win11.shardx,
              second,
              asRecord(await readJson(req)).headless === true,
            )
          : await shardx.stop(config.settings.shardx, config.groups.win11.shardx, second);
      send(res, result.ok ? 200 : 400, { ok: result.ok, data: result, error: result.error });
      return;
    }
  }

  if (root === 'wsl' && method === 'GET' && parts.length === 1) {
    const config = configStore.get();
    send(res, 200, {
      ok: true,
      data: await wsl.snapshot(config.settings.wsl, config.groups.wsl.ports),
    });
    return;
  }

  if (root === 'docker') {
    if (method === 'GET' && parts.length === 1) {
      send(res, 200, { ok: true, data: await docker.snapshot() });
      return;
    }
    if (method === 'POST' && second === 'containers' && third && fourth) {
      const allowed = ['start', 'stop', 'restart', 'kill', 'pause', 'unpause'] as const;
      if (!allowed.includes(fourth as (typeof allowed)[number])) {
        throw new HttpError(400, 'invalid-action');
      }
      const result = await docker.containerAction(
        third,
        fourth as (typeof allowed)[number],
      );
      send(res, result.ok ? 200 : 400, { ok: result.ok, data: result });
      return;
    }
    if (method === 'POST' && second === 'compose' && third) {
      const allowed = ['up', 'down', 'ps', 'restart'] as const;
      if (!allowed.includes(third as (typeof allowed)[number])) {
        throw new HttpError(400, 'invalid-action');
      }
      const body = asRecord(await readJson(req));
      const files = Array.isArray(body.files)
        ? body.files.filter((file): file is string => typeof file === 'string')
        : configStore.get().settings.docker.composeFiles;
      const result = await docker.compose(
        third as (typeof allowed)[number],
        files,
        asString(body.cwd) || undefined,
      );
      send(res, result.ok ? 200 : 400, { ok: result.ok, data: result });
      return;
    }
  }

  if (root === 'k8s') {
    if (method === 'GET' && parts.length === 1) {
      send(res, 200, { ok: true, data: await k8s.snapshot(configStore.get().settings.k8s) });
      return;
    }
    if (method === 'POST' && second === 'forward' && parts.length === 2) {
      const body = asRecord(await readJson(req));
      const result = await k8s.startForward({
        context: asString(body.context),
        namespace: asString(body.namespace, 'default'),
        pod: asString(body.pod),
        localPort: asNumber(body.localPort, 0),
        remotePort: asNumber(body.remotePort, 0),
      });
      send(res, result.running ? 200 : 400, { ok: result.running, data: result });
      return;
    }
    if (
      (method === 'DELETE' && second === 'forward' && third) ||
      (method === 'POST' && second === 'forward' && third && fourth === 'stop')
    ) {
      const stopped = await k8s.stopForward(third);
      send(res, stopped ? 200 : 404, { ok: stopped, data: { id: third, stopped } });
      return;
    }
  }

  if (root === 'terminal') {
    if (method === 'POST' && second === 'exec') {
      const body = asRecord(await readJson(req));
      const result = await terminal.exec({
        command: asString(body.command),
        shell: body.shell as never,
        cwd: asString(body.cwd) || undefined,
        distro: asString(body.distro) || undefined,
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      });
      send(res, 200, { ok: true, data: result });
      return;
    }
    if (method === 'POST' && second === 'sessions' && parts.length === 2) {
      const body = asRecord(await readJson(req));
      const info = terminal.create({
        shell: body.shell as never,
        cwd: asString(body.cwd) || undefined,
        distro: asString(body.distro) || undefined,
      });
      send(res, 200, { ok: true, data: info });
      return;
    }
    if (method === 'GET' && second === 'sessions' && parts.length === 2) {
      send(res, 200, { ok: true, data: terminal.list() });
      return;
    }
    if (second === 'sessions' && third) {
      if (method === 'GET' && fourth === 'output') {
        const output = terminal.output(third, asNumber(url.searchParams.get('since'), 0));
        if (!output) throw new HttpError(404, 'session-not-found');
        send(res, 200, { ok: true, data: output });
        return;
      }
      if (method === 'POST' && fourth === 'input') {
        const text = asString(asRecord(await readJson(req)).text);
        const written = terminal.write(third, text);
        send(res, written ? 200 : 404, { ok: written, data: { id: third, written } });
        return;
      }
      if (method === 'DELETE' && parts.length === 3) {
        const stopped = await terminal.stop(third);
        send(res, stopped ? 200 : 404, { ok: stopped, data: { id: third, stopped } });
        return;
      }
    }
  }

  if (root === 'browser') {
    if (method === 'POST' && second === 'sessions' && parts.length === 2) {
      const body = asRecord(await readJson(req));
      const info = await browser.start({
        url: asString(body.url) || undefined,
        width: asNumber(body.width, 0) || undefined,
        height: asNumber(body.height, 0) || undefined,
      });
      send(res, 200, { ok: true, data: info });
      return;
    }
    if (method === 'GET' && second === 'sessions' && parts.length === 2) {
      send(res, 200, { ok: true, data: browser.list() });
      return;
    }
    if (second === 'sessions' && third) {
      if (method === 'GET' && fourth === 'frame') {
        const frame = await browser.frame(
          third,
          asNumber(url.searchParams.get('since'), 0),
          asNumber(url.searchParams.get('wait'), 12_000),
        );
        send(res, 200, { ok: true, data: frame });
        return;
      }
      if (method === 'POST' && fourth === 'navigate') {
        const target = asString(asRecord(await readJson(req)).url);
        if (!target) throw new HttpError(400, 'missing-url');
        send(res, 200, { ok: true, data: await browser.navigate(third, target) });
        return;
      }
      if (method === 'POST' && fourth === 'input') {
        const body = asRecord(await readJson(req));
        const input = (body.input ?? body) as BrowserInput;
        const applied = await browser.input(third, input);
        send(res, applied ? 200 : 404, { ok: applied, data: { applied } });
        return;
      }
      if (method === 'DELETE' && parts.length === 3) {
        const closed = await browser.close(third);
        send(res, closed ? 200 : 404, { ok: closed, data: { id: third, closed } });
        return;
      }
    }
  }

  if (root === 'logs') {
    if (method === 'GET' && second === 'sources' && parts.length === 2) {
      send(res, 200, { ok: true, data: await logs.sources() });
      return;
    }
    if (method === 'POST' && second === 'subscriptions' && parts.length === 2) {
      const sourceId = asString(asRecord(await readJson(req)).sourceId);
      send(res, 200, { ok: true, data: logs.subscribe(sourceId) });
      return;
    }
    if (method === 'GET' && second === 'subscriptions' && parts.length === 2) {
      send(res, 200, { ok: true, data: logs.list() });
      return;
    }
    if (second === 'subscriptions' && third) {
      if (method === 'GET' && fourth === 'output') {
        const output = logs.output(third, asNumber(url.searchParams.get('since'), 0));
        if (!output) throw new HttpError(404, 'subscription-not-found');
        send(res, 200, { ok: true, data: output });
        return;
      }
      if (method === 'DELETE' && parts.length === 3) {
        const stopped = await logs.stop(third);
        send(res, stopped ? 200 : 404, { ok: stopped, data: { id: third, stopped } });
        return;
      }
    }
  }

  if (root === 'variables') {
    if (method === 'POST' && parts.length === 1) {
      const body = asRecord(await readJson(req));
      send(res, 200, {
        ok: true,
        data: await createVariableContext(
          {
            path: asString(body.path) || undefined,
            winPath: asString(body.winPath) || undefined,
            gitBranch: asString(body.gitBranch) || undefined,
            wslIp: asString(body.wslIp) || undefined,
            host: asString(body.host) || undefined,
            port: typeof body.port === 'string' || typeof body.port === 'number' ? body.port : undefined,
          },
          configStore.get(),
        ),
      });
      return;
    }
    if (method === 'POST' && second === 'expand' && parts.length === 2) {
      const body = asRecord(await readJson(req));
      const template = asString(body.template);
      const context = await createVariableContext({ path: asString(body.path) || undefined }, configStore.get());
      send(res, 200, { ok: true, data: { value: expandTemplate(template, context) } });
      return;
    }
  }

  if (root === 'webhooks' && second && method === 'POST' && third === 'run') {
    const body = asRecord(await readJson(req));
    const result = await runWebhook(second, asString(body.path) || process.cwd());
    send(res, 200, { ok: true, data: result });
    return;
  }

  send(res, 404, { ok: false, error: 'not-found', detail: `${method} ${url.pathname}` });
};

const server = http.createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (status >= 500) log(`request failed: ${message}`);
    if (!res.headersSent) {
      send(res, status, { ok: false, error: status === 500 ? 'internal' : message, detail: message });
    } else {
      res.end();
    }
  });
});

const shutdown = async (signal: string): Promise<void> => {
  log(`received ${signal}, shutting down`);
  server.close();
  await Promise.allSettled([
    browser.stopAll(),
    terminal.stopAll(),
    logs.stopAll(),
    k8s.stopAll(),
  ]);
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

const start = async (): Promise<void> => {
  const config = await configStore.init();
  launcher.setApps(config.groups.win11.apps);
  configStore.onChange((next) => launcher.setApps(next.groups.win11.apps));
  server.listen(PORT, '127.0.0.1', () => {
    log(`openwith-matrix ${MATRIX_VERSION} listening on 127.0.0.1:${PORT}; config=${CONFIG_PATH}`);
  });
};

void start().catch((error: unknown) => {
  log(`startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});

// Referenced for type completeness in the snapshot builder.
void (null as unknown as MatrixConfig);
