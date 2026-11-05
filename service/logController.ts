/**
 * Log-stream group.
 *
 * A subscription turns one configured source into a bounded chunk stream the
 * panel polls. Three source kinds are supported: a local file (tail -f style),
 * a long-running command (docker compose logs, journalctl, ...), and an HTTP
 * endpoint polled for changes.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';

import type {
  LogChunk,
  LogOutput,
  LogSourceConfig,
  LogSourceInfo,
  LogSubscriptionInfo,
  MatrixConfig,
} from '../shared/types.ts';
import { expandHome, killTree, which } from './processUtils.ts';

const MAX_SUBSCRIPTIONS = 24;
const MAX_CHUNKS = 500;
const MAX_BYTES = 512 * 1024;
const FILE_POLL_MS = 500;
const URL_POLL_MS = 2000;

interface Subscription {
  id: string;
  source: LogSourceConfig;
  createdAt: number;
  alive: boolean;
  error?: string;
  chunks: LogChunk[];
  bytes: number;
  seq: number;
  truncated: boolean;
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
  offset?: number;
  busy?: boolean;
  lastBody?: string;
}

let counter = 0;
const nextId = (): string => `log-${Date.now().toString(36)}-${(counter += 1)}`;

export class LogController {
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(private readonly getConfig: () => MatrixConfig) {}

  sources(): Promise<LogSourceInfo[]> {
    const sources = this.getConfig().settings.logSources;
    return Promise.all(
      sources.map(async (source) => {
        let available = true;
        let error: string | undefined;
        if (source.kind === 'file') {
          try {
            await fsp.access(expandHome(source.target));
          } catch {
            available = false;
            error = 'file-missing';
          }
        } else if (source.kind === 'command') {
          available = await which(source.target);
          if (!available) error = 'command-missing';
        }
        return {
          id: source.id,
          name: source.name,
          kind: source.kind,
          target: source.target,
          available,
          ...(error ? { error } : {}),
        };
      }),
    );
  }

  subscribe(sourceId: string): LogSubscriptionInfo {
    if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
      throw new Error('too-many-log-subscriptions');
    }
    const source = this.getConfig().settings.logSources.find((entry) => entry.id === sourceId);
    if (!source) throw new Error('unknown-log-source');

    const subscription: Subscription = {
      id: nextId(),
      source,
      createdAt: Date.now(),
      alive: true,
      chunks: [],
      bytes: 0,
      seq: 1,
      truncated: false,
    };
    this.subscriptions.set(subscription.id, subscription);

    if (source.kind === 'file') this.startFile(subscription);
    else if (source.kind === 'command') this.startCommand(subscription);
    else this.startUrl(subscription);

    return this.info(subscription);
  }

  list(): LogSubscriptionInfo[] {
    return [...this.subscriptions.values()].map((subscription) => this.info(subscription));
  }

  output(id: string, since = 0): LogOutput | null {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return null;
    const chunks = subscription.chunks.filter((chunk) => chunk.seq > since);
    return {
      chunks,
      nextSeq: subscription.seq,
      truncated:
        subscription.truncated || (chunks.length > 0 && chunks[0]!.seq > since + 1),
      alive: subscription.alive,
      ...(subscription.error ? { error: subscription.error } : {}),
    };
  }

  async stop(id: string): Promise<boolean> {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return false;
    subscription.alive = false;
    if (subscription.timer) clearInterval(subscription.timer);
    if (subscription.child) await killTree(subscription.child);
    this.subscriptions.delete(id);
    return true;
  }

  async stopAll(): Promise<void> {
    const children = [...this.subscriptions.values()]
      .map((subscription) => subscription.child)
      .filter((child): child is ChildProcess => Boolean(child));
    for (const subscription of this.subscriptions.values()) {
      if (subscription.timer) clearInterval(subscription.timer);
    }
    this.subscriptions.clear();
    await Promise.all(children.map((child) => killTree(child)));
  }

  private push(
    subscription: Subscription,
    stream: 'stdout' | 'stderr' | 'system',
    text: string,
  ): void {
    if (!text) return;
    subscription.chunks.push({
      seq: subscription.seq,
      sourceId: subscription.source.id,
      stream,
      text,
      at: Date.now(),
    });
    subscription.seq += 1;
    subscription.bytes += Buffer.byteLength(text, 'utf8');
    while (
      subscription.chunks.length > MAX_CHUNKS ||
      subscription.bytes > MAX_BYTES
    ) {
      const dropped = subscription.chunks.shift();
      if (!dropped) break;
      subscription.bytes -= Buffer.byteLength(dropped.text, 'utf8');
      subscription.truncated = true;
    }
  }

  private startFile(subscription: Subscription): void {
    const file = expandHome(subscription.source.target);
    const tick = async (): Promise<void> => {
      if (subscription.busy || !subscription.alive) return;
      subscription.busy = true;
      try {
        const handle = await fsp.open(file, 'r');
        try {
          const stat = await handle.stat();
          if (subscription.offset === undefined) {
            subscription.offset = Math.max(0, stat.size - 64 * 1024);
          } else if (stat.size < subscription.offset) {
            subscription.offset = 0;
            this.push(subscription, 'system', '\n[file truncated]\n');
          }
          const remaining = stat.size - subscription.offset;
          if (remaining > 0) {
            const length = Math.min(remaining, 256 * 1024);
            const buffer = Buffer.alloc(length);
            const read = await handle.read(buffer, 0, length, subscription.offset);
            if (read.bytesRead > 0) {
              subscription.offset += read.bytesRead;
              this.push(subscription, 'stdout', buffer.subarray(0, read.bytesRead).toString('utf8'));
            }
          }
        } finally {
          await handle.close();
        }
      } catch (error) {
        subscription.error = error instanceof Error ? error.message : String(error);
      } finally {
        subscription.busy = false;
      }
    };
    subscription.timer = setInterval(() => void tick(), FILE_POLL_MS);
    void tick();
  }

  private startCommand(subscription: Subscription): void {
    const source = subscription.source;
    let child: ChildProcess;
    try {
      child = spawn(source.target, source.args ?? [], {
        cwd: source.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      subscription.alive = false;
      subscription.error = error instanceof Error ? error.message : String(error);
      this.push(subscription, 'system', `[spawn failed] ${subscription.error}\n`);
      return;
    }
    subscription.child = child;
    child.stdout?.on('data', (chunk: Buffer) =>
      this.push(subscription, 'stdout', chunk.toString('utf8')),
    );
    child.stderr?.on('data', (chunk: Buffer) =>
      this.push(subscription, 'stderr', chunk.toString('utf8')),
    );
    child.on('error', (error) => {
      subscription.alive = false;
      subscription.error = error.message;
      this.push(subscription, 'system', `[spawn error] ${error.message}\n`);
    });
    child.on('exit', (code, signal) => {
      subscription.alive = false;
      this.push(
        subscription,
        'system',
        `\n[process exited code=${code ?? '-'} signal=${signal ?? '-'}]\n`,
      );
    });
  }

  private startUrl(subscription: Subscription): void {
    const tick = async (): Promise<void> => {
      if (subscription.busy || !subscription.alive) return;
      subscription.busy = true;
      try {
        const response = await fetch(subscription.source.target, {
          signal: AbortSignal.timeout(8000),
        });
        const text = await response.text();
        if (text !== subscription.lastBody) {
          const previous = subscription.lastBody;
          subscription.lastBody = text;
          if (previous && text.startsWith(previous)) {
            this.push(subscription, 'stdout', text.slice(previous.length));
          } else {
            this.push(subscription, 'stdout', text.slice(0, 256 * 1024));
          }
        }
        subscription.error = undefined;
      } catch (error) {
        subscription.error = error instanceof Error ? error.message : String(error);
      } finally {
        subscription.busy = false;
      }
    };
    subscription.timer = setInterval(() => void tick(), URL_POLL_MS);
    void tick();
  }

  private info(subscription: Subscription): LogSubscriptionInfo {
    return {
      id: subscription.id,
      sourceId: subscription.source.id,
      name: subscription.source.name,
      kind: subscription.source.kind,
      target: subscription.source.target,
      alive: subscription.alive,
      createdAt: subscription.createdAt,
      ...(subscription.error ? { error: subscription.error } : {}),
    };
  }
}
