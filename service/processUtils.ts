/**
 * Small process helpers shared by the service controllers.
 *
 * Everything here is best-effort: a missing binary, a killed child or an
 * undecodable byte sequence must never take the service down. Callers get a
 * result object and decide what to show the user.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

export interface CaptureOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
  input?: string;
  windowsHide?: boolean;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** Decode a child process buffer, tolerating UTF-16 BOMs from Windows tools. */
export function decodeText(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8');
}

/** Expand a leading `~` to the current user's home directory. */
export function expandHome(target: string): string {
  if (target === '~') return os.homedir();
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return path.join(os.homedir(), target.slice(2));
  }
  return target;
}

/** Quote one argument for cmd.exe's `/s /c` parsing. */
export function quoteWindowsArg(value: string): string {
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Run a command to completion and capture bounded stdout/stderr. */
export function runCapture(
  command: string,
  args: string[] = [],
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    let timer: NodeJS.Timeout | null = null;

    const finish = (code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code,
        stdout: decodeText(Buffer.concat(stdout)),
        stderr: decodeText(Buffer.concat(stderr)),
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(error ? { error } : {}),
      });
    };

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: options.windowsHide ?? true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        void killTree(child);
        finish(null, 'timeout');
      }, options.timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= maxBytes) return;
      stdoutBytes += chunk.length;
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= maxBytes) return;
      stderrBytes += chunk.length;
      stderr.push(chunk);
    });
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code));

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

/** Start a process that outlives the request. Returns the pid, or null. */
export function runDetached(
  command: string,
  args: string[] = [],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): number | null {
  try {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

/** Kill a process and, on Windows, its whole tree. */
export async function killTree(child: ChildProcess | null | undefined): Promise<void> {
  const pid = child?.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    await runCapture('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 5000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

/** True when a command resolves on PATH (or is an existing absolute path). */
export async function which(command: string): Promise<boolean> {
  if (!command) return false;
  if (path.isAbsolute(command) || /^[A-Za-z]:[\\/]/.test(command)) {
    try {
      await fsp.access(command);
      return true;
    } catch {
      return false;
    }
  }
  const result =
    process.platform === 'win32'
      ? await runCapture('where.exe', [command], { timeoutMs: 5000 })
      : await runCapture('sh', ['-lc', `command -v ${JSON.stringify(command)}`], {
          timeoutMs: 5000,
        });
  return result.code === 0 && result.stdout.trim().length > 0;
}

/** Launch a path or command through the platform's default handler. */
export function openWithShell(target: string): boolean {
  if (process.platform === 'win32') {
    return runDetached('explorer.exe', [target]) !== null;
  }
  if (process.platform === 'darwin') {
    return runDetached('open', [target]) !== null;
  }
  return runDetached('xdg-open', [target]) !== null;
}

/** Convert a native path to a Windows path string for templates. */
export function toWindowsPath(target: string): string {
  if (/^[A-Za-z]:[\\/]/.test(target)) return target.replace(/\//g, '\\');
  if (target.startsWith('/mnt/') && target.length > 6) {
    const drive = target[5]?.toUpperCase() ?? 'C';
    return `${drive}:${target.slice(6).replace(/\//g, '\\')}`;
  }
  return target.replace(/\//g, '\\');
}
