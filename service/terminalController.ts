/**
 * Terminal group.
 *
 * Two modes share one controller: a one-shot command that returns captured
 * output, and a persistent shell session that streams chunks the panel polls.
 * Both run as ordinary child processes of the service; the sandboxed panel
 * never touches a shell directly.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import type {
  TerminalChunk,
  TerminalExecResult,
  TerminalOutput,
  TerminalSessionInfo,
  TerminalShell,
} from '../shared/types.ts';
import { killTree, runCapture } from './processUtils.ts';

const MAX_CHUNKS = 600;
const MAX_BYTES = 512 * 1024;

interface Session {
  id: string;
  shell: TerminalShell;
  cwd: string;
  distro?: string;
  createdAt: number;
  child: ChildProcess;
  chunks: TerminalChunk[];
  bytes: number;
  seq: number;
  truncated: boolean;
  alive: boolean;
}

interface ExecInput {
  command: string;
  shell?: TerminalShell;
  cwd?: string;
  distro?: string;
  timeoutMs?: number;
}

interface SessionInput {
  shell?: TerminalShell;
  cwd?: string;
  distro?: string;
}

const shellArgs = (
  shell: TerminalShell,
  command: string,
  distro: string,
): { command: string; args: string[] } => {
  if (shell === 'cmd') return { command: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  if (shell === 'wsl') return { command: 'wsl.exe', args: ['-d', distro, '--', 'bash', '-lc', command] };
  if (shell === 'bash') return { command: 'bash', args: ['-lc', command] };
  const script = `$ProgressPreference='SilentlyContinue'; $OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded] };
};

const sessionLaunch = (
  shell: TerminalShell,
  distro: string,
): { command: string; args: string[]; init: string } => {
  if (shell === 'cmd') return { command: 'cmd.exe', args: ['/Q', '/K', 'chcp 65001>nul'], init: '' };
  if (shell === 'wsl') return { command: 'wsl.exe', args: ['-d', distro, '--', 'bash', '-i'], init: '' };
  if (shell === 'bash') return { command: 'bash', args: ['-i'], init: '' };
  return {
    command: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-Command', '-'],
    init: `$ProgressPreference='SilentlyContinue'\r\n[Console]::OutputEncoding=[Text.Encoding]::UTF8\r\n`,
  };
};

let counter = 0;
const nextId = (): string => `term-${Date.now().toString(36)}-${(counter += 1)}`;

export class TerminalController {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly defaultShell: () => TerminalShell, private readonly defaultDistro: () => string) {}

  async exec(input: ExecInput): Promise<TerminalExecResult> {
    const shell = input.shell ?? this.defaultShell();
    const distro = input.distro ?? this.defaultDistro();
    const built = shellArgs(shell, input.command, distro);
    const result = await runCapture(built.command, built.args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? 60_000,
      maxBytes: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      ok: result.code === 0 && !result.timedOut,
      exitCode: result.code ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    };
  }

  create(input: SessionInput = {}): TerminalSessionInfo {
    const shell = input.shell ?? this.defaultShell();
    const distro = input.distro ?? this.defaultDistro();
    const cwd = input.cwd ?? process.cwd();
    const launch = sessionLaunch(shell, distro);
    const child = spawn(launch.command, launch.args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session: Session = {
      id: nextId(),
      shell,
      cwd,
      ...(shell === 'wsl' ? { distro } : {}),
      createdAt: Date.now(),
      child,
      chunks: [],
      bytes: 0,
      seq: 1,
      truncated: false,
      alive: true,
    };
    this.sessions.set(session.id, session);
    if (launch.init) child.stdin?.write(launch.init);
    this.attach(session);
    return this.info(session);
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((session) => this.info(session));
  }

  output(id: string, since = 0): TerminalOutput | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const chunks = session.chunks.filter((chunk) => chunk.seq > since);
    return {
      chunks,
      nextSeq: session.seq,
      truncated: session.truncated || (chunks.length > 0 && chunks[0]!.seq > since + 1),
      alive: session.alive,
    };
  }

  write(id: string, text: string): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.alive) return false;
    const line = /[\r\n]$/.test(text) ? text : `${text}\r\n`;
    session.child.stdin?.write(line);
    return true;
  }

  async stop(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.alive = false;
    await killTree(session.child);
    this.sessions.delete(id);
    return true;
  }

  async stopAll(): Promise<void> {
    const children = [...this.sessions.values()].map((session) => session.child);
    this.sessions.clear();
    await Promise.all(children.map((child) => killTree(child)));
  }

  private attach(session: Session): void {
    const push = (stream: 'stdout' | 'stderr' | 'system', text: string): void => {
      if (!text) return;
      const chunk: TerminalChunk = { seq: session.seq, stream, text, at: Date.now() };
      session.seq += 1;
      session.chunks.push(chunk);
      session.bytes += Buffer.byteLength(text, 'utf8');
      while (session.chunks.length > MAX_CHUNKS || session.bytes > MAX_BYTES) {
        const dropped = session.chunks.shift();
        if (!dropped) break;
        session.bytes -= Buffer.byteLength(dropped.text, 'utf8');
        session.truncated = true;
      }
    };
    session.child.stdout?.on('data', (chunk: Buffer) => push('stdout', chunk.toString('utf8')));
    session.child.stderr?.on('data', (chunk: Buffer) => push('stderr', chunk.toString('utf8')));
    session.child.on('error', (error) => {
      session.alive = false;
      push('system', `\n[spawn error] ${error.message}\n`);
    });
    session.child.on('exit', (code, signal) => {
      session.alive = false;
      push('system', `\n[process exited code=${code ?? '-'} signal=${signal ?? '-'}]\n`);
    });
  }

  private info(session: Session): TerminalSessionInfo {
    return {
      id: session.id,
      shell: session.shell,
      cwd: session.cwd,
      ...(session.distro ? { distro: session.distro } : {}),
      alive: session.alive,
      createdAt: session.createdAt,
    };
  }
}
