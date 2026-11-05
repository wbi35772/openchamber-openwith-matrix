/**
 * Template variables for bookmarks, webhooks and log sources.
 *
 * A template such as `https://example.com/?path={path}` is expanded with facts
 * about the open project and the machine. `gitBranch` and `wslIp` are looked up
 * lazily and cached: the panel may expand dozens of bookmarks in one render.
 */

import os from 'node:os';
import path from 'node:path';

import type {
  JsonValue,
  MatrixConfig,
  VariableContext,
  VariableInput,
} from '../shared/types.ts';
import { runCapture, toWindowsPath } from './processUtils.ts';

const branchCache = new Map<string, { value: string; at: number }>();
const wslIpCache = new Map<string, { value: string; at: number }>();
const BRANCH_TTL_MS = 10_000;
const WSL_IP_TTL_MS = 30_000;

const gitBranch = async (directory: string): Promise<string> => {
  const cached = branchCache.get(directory);
  if (cached && Date.now() - cached.at < BRANCH_TTL_MS) return cached.value;
  const result = await runCapture('git', ['-C', directory, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    timeoutMs: 4000,
    maxBytes: 4096,
  });
  const value = result.code === 0 ? result.stdout.trim() : '';
  branchCache.set(directory, { value, at: Date.now() });
  return value;
};

const wslIp = async (distro: string): Promise<string> => {
  if (!distro) return '';
  const cached = wslIpCache.get(distro);
  if (cached && Date.now() - cached.at < WSL_IP_TTL_MS) return cached.value;
  const result = await runCapture('wsl.exe', ['-d', distro, '--', 'hostname', '-I'], {
    timeoutMs: 8000,
    maxBytes: 8192,
  });
  const value = result.code === 0 ? (result.stdout.trim().split(/\s+/)[0] ?? '') : '';
  wslIpCache.set(distro, { value, at: Date.now() });
  return value;
};

const pad = (value: number): string => String(value).padStart(2, '0');

const localDate = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const collectEnv = (input: VariableInput): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
};

/** Build the value set used by `expandTemplate`. */
export async function createVariableContext(
  input: VariableInput = {},
  config?: MatrixConfig,
): Promise<VariableContext> {
  const now = new Date();
  const directory = path.resolve(input.path ?? process.cwd());
  const distro = config?.settings.wsl.distro ?? '';

  return {
    path: directory,
    winPath: input.winPath ?? toWindowsPath(directory),
    pathUrlEncode: encodeURIComponent(directory),
    projectName: path.basename(directory),
    gitBranch: input.gitBranch ?? (await gitBranch(directory)),
    wslIp: input.wslIp ?? (await wslIp(distro)),
    host: input.host ?? os.hostname(),
    port: String(input.port ?? 3000),
    date: localDate(now),
    now: now.toISOString(),
    env: collectEnv(input),
  };
}

/** Replace `{name}` placeholders. Unknown placeholders stay visible. */
export function expandTemplate(template: string, context: VariableContext): string {
  return template.replace(/\{([A-Za-z0-9_.]+)\}/g, (match, name: string) => {
    if (name.startsWith('env.')) {
      const key = name.slice(4);
      return context.env[key] ?? match;
    }
    const value = (context as unknown as Record<string, unknown>)[name];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : match;
  });
}

/** Expand every string inside a JSON value (arrays and objects included). */
export function expandValue(value: JsonValue, context: VariableContext): JsonValue {
  if (typeof value === 'string') return expandTemplate(value, context);
  if (Array.isArray(value)) return value.map((item) => expandValue(item, context));
  if (value && typeof value === 'object') {
    const next: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) next[key] = expandValue(item, context);
    return next;
  }
  return value;
}

/** Expand `{...}` in a string record such as webhook headers. */
export function expandRecord(
  record: Record<string, string>,
  context: VariableContext,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) next[key] = expandTemplate(value, context);
  return next;
}
