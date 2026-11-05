/**
 * Browser-tab backend: a real headless Chrome/Edge driven over CDP.
 *
 * The panel cannot embed an arbitrary site (its CSP only allows its own
 * origin), so a `web-iframe` tab is a screencast of a browser owned by this
 * service. Frames are JPEG data URLs polled by the panel; mouse, keyboard and
 * text input are forwarded to the page.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  BrowserFrame,
  BrowserInput,
  BrowserSessionInfo,
  BrowserSettings,
} from '../shared/types.ts';
import { killTree } from './processUtils.ts';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Session {
  id: string;
  url: string;
  title: string;
  width: number;
  height: number;
  createdAt: number;
  proc: ChildProcess;
  ws: WebSocket;
  dir: string;
  seq: number;
  frame?: BrowserFrame;
  waiters: Set<() => void>;
  alive: boolean;
  pending: Map<number, Pending>;
  nextId: number;
  stderr: string;
}

const START_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 10_000;
const FRAME_WAIT_MS = 12_000;

let counter = 0;
const nextId = (): string => `web-${Date.now().toString(36)}-${(counter += 1)}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const keyCode = (key: string): number => {
  const named: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Backspace: 8,
    Escape: 27,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Delete: 46,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    ' ': 32,
  };
  if (named[key] !== undefined) return named[key]!;
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return 0;
};

export class BrowserController {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly settings: () => BrowserSettings) {}

  private async executable(): Promise<string> {
    const settings = this.settings();
    for (const candidate of [settings.chromePath, settings.edgePath]) {
      if (!candidate) continue;
      try {
        await fsp.access(candidate);
        return candidate;
      } catch {
        /* try next */
      }
    }
    throw new Error('browser-not-found');
  }

  async start(options: { url?: string; width?: number; height?: number } = {}): Promise<BrowserSessionInfo> {
    const settings = this.settings();
    const width = options.width ?? settings.viewportWidth ?? 1280;
    const height = options.height ?? settings.viewportHeight ?? 800;
    const executable = await this.executable();
    const id = nextId();
    const dir = path.join(os.tmpdir(), `openwith-browser-${id}`);
    await fsp.mkdir(dir, { recursive: true });

    const proc = spawn(
      executable,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--remote-allow-origins=*',
        '--remote-debugging-port=0',
        `--user-data-dir=${dir}`,
        `--window-size=${width},${height}`,
        'about:blank',
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );

    const session: Session = {
      id,
      url: options.url ?? 'about:blank',
      title: '',
      width,
      height,
      createdAt: Date.now(),
      proc,
      ws: null as unknown as WebSocket,
      dir,
      seq: 0,
      waiters: new Set(),
      alive: true,
      pending: new Map(),
      nextId: 1,
      stderr: '',
    };
    proc.stderr?.on('data', (chunk: Buffer) => {
      session.stderr = `${session.stderr}${chunk.toString('utf8')}`.slice(-4000);
    });
    proc.on('exit', () => {
      session.alive = false;
      this.rejectPending(session, 'browser-exited');
      this.wake(session);
    });

    const port = await this.waitForPort(session);
    const target = await this.pageTarget(port);
    const ws = new WebSocket(target);
    session.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('browser-ws-timeout')), START_TIMEOUT_MS);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('browser-ws-error'));
      });
    });

    ws.addEventListener('message', (event) => {
      this.onMessage(session, event);
    });
    ws.addEventListener('close', () => {
      session.alive = false;
      this.rejectPending(session, 'browser-disconnected');
      this.wake(session);
    });

    this.sessions.set(id, session);
    await this.send(session, 'Page.enable');
    await this.send(session, 'Runtime.enable');
    await this.send(session, 'Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await this.send(session, 'Page.startScreencast', {
      format: 'jpeg',
      quality: settings.jpegQuality ?? 55,
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: 1,
    });
    if (session.url !== 'about:blank') await this.navigate(id, session.url);
    return this.info(session);
  }

  list(): BrowserSessionInfo[] {
    return [...this.sessions.values()].map((session) => this.info(session));
  }

  infoFor(id: string): BrowserSessionInfo | null {
    const session = this.sessions.get(id);
    return session ? this.info(session) : null;
  }

  async navigate(id: string, url: string): Promise<BrowserSessionInfo> {
    const session = this.sessions.get(id);
    if (!session) throw new Error('unknown-browser-session');
    session.url = url;
    await this.send(session, 'Page.navigate', { url });
    void sleep(350).then(() => this.refreshTitle(session));
    return this.info(session);
  }

  async input(id: string, input: BrowserInput): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (input.type === 'text') {
      await this.send(session, 'Input.insertText', { text: input.text });
      return true;
    }
    if (input.type === 'mouse') {
      const button = input.button ?? 'left';
      const common = { x: input.x, y: input.y, button, clickCount: input.clickCount ?? 1 };
      if (input.action === 'move') {
        await this.send(session, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: input.x, y: input.y });
      } else if (input.action === 'down') {
        await this.send(session, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
      } else if (input.action === 'up') {
        await this.send(session, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
      } else if (input.action === 'click') {
        await this.send(session, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
        await this.send(session, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
      } else {
        await this.send(session, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: input.x,
          y: input.y,
          deltaX: input.deltaX ?? 0,
          deltaY: input.deltaY ?? 0,
        });
      }
      return true;
    }

    const code = input.code ?? input.key;
    const virtual = keyCode(input.key);
    const base = {
      key: input.key,
      code,
      windowsVirtualKeyCode: virtual,
      nativeVirtualKeyCode: virtual,
      modifiers: input.modifiers ?? 0,
      ...(input.text ? { text: input.text } : {}),
    };
    if (input.action === 'down' || input.action === 'press') {
      await this.send(session, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    }
    if (input.action === 'up' || input.action === 'press') {
      await this.send(session, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }
    return true;
  }

  /** Wait for the next frame after `since`; returns the latest frame or null. */
  async frame(id: string, since = 0, waitMs = FRAME_WAIT_MS): Promise<BrowserFrame | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.frame && session.frame.seq > since) return session.frame;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        session.waiters.delete(wake);
        resolve();
      }, waitMs);
      const wake = (): void => {
        clearTimeout(timer);
        session.waiters.delete(wake);
        resolve();
      };
      session.waiters.add(wake);
    });
    return session.frame && session.frame.seq > since ? session.frame : null;
  }

  async close(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.alive = false;
    try {
      session.ws.close();
    } catch {
      /* already closed */
    }
    this.rejectPending(session, 'browser-closed');
    this.wake(session);
    this.sessions.delete(id);
    await killTree(session.proc);
    await fsp.rm(session.dir, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }

  private async waitForPort(session: Session): Promise<number> {
    const file = path.join(session.dir, 'DevToolsActivePort');
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!session.alive) throw new Error(`browser-exited: ${session.stderr.trim()}`);
      try {
        const text = await fsp.readFile(file, 'utf8');
        const port = Number(text.split(/\r?\n/)[0]);
        if (Number.isFinite(port) && port > 0) return port;
      } catch {
        /* not written yet */
      }
      await sleep(120);
    }
    throw new Error(`browser-start-timeout: ${session.stderr.trim()}`);
  }

  private async pageTarget(port: number): Promise<string> {
    const list = await this.fetchJson<Array<{ type?: string; webSocketDebuggerUrl?: string }>>(
      `http://127.0.0.1:${port}/json/list`,
    );
    const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    const created = await this.fetchJson<{ webSocketDebuggerUrl?: string }>(
      `http://127.0.0.1:${port}/json/new?about:blank`,
      { method: 'PUT' },
    );
    if (!created.webSocketDebuggerUrl) throw new Error('browser-no-page-target');
    return created.webSocketDebuggerUrl;
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    return (await response.json()) as T;
  }

  private send(session: Session, method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!session.alive) return Promise.reject(new Error('browser-session-closed'));
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`browser-command-timeout: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      session.pending.set(id, { resolve, reject, timer });
      session.ws.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
    });
  }

  private onMessage(session: Session, event: MessageEvent): void {
    const text = typeof event.data === 'string' ? event.data : String(event.data);
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }

    if (typeof message.id === 'number') {
      const pending = session.pending.get(message.id);
      if (!pending) return;
      session.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? 'browser-command-failed'));
      else pending.resolve(message.result);
      return;
    }

    if (message.method === 'Page.screencastFrame') {
      const params = message.params ?? {};
      const metadata = (params.metadata ?? {}) as {
        deviceWidth?: number;
        deviceHeight?: number;
      };
      const data = String(params.data ?? '');
      if (data) {
        session.frame = {
          seq: (session.seq += 1),
          mime: 'image/jpeg',
          data,
          width: metadata.deviceWidth ?? session.width,
          height: metadata.deviceHeight ?? session.height,
          at: Date.now(),
        };
        this.wake(session);
      }
      void this.send(session, 'Page.screencastFrameAck', {
        sessionId: params.sessionId,
      }).catch(() => undefined);
      return;
    }

    if (message.method === 'Page.loadEventFired' || message.method === 'Page.frameNavigated') {
      void this.refreshTitle(session);
    }
  }

  private refreshTitle(session: Session): void {
    void this.send(session, 'Runtime.evaluate', {
      expression: '({ title: document.title, url: location.href })',
      returnByValue: true,
    })
      .then((result) => {
        const value = (result as { result?: { value?: { title?: string; url?: string } } }).result
          ?.value;
        if (value?.title !== undefined) session.title = value.title;
        if (value?.url) session.url = value.url;
      })
      .catch(() => undefined);
  }

  private wake(session: Session): void {
    for (const waiter of [...session.waiters]) waiter();
  }

  private rejectPending(session: Session, reason: string): void {
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    session.pending.clear();
  }

  private info(session: Session): BrowserSessionInfo {
    return {
      id: session.id,
      url: session.url,
      title: session.title,
      width: session.width,
      height: session.height,
      alive: session.alive,
      createdAt: session.createdAt,
      frameSeq: session.seq,
    };
  }
}
