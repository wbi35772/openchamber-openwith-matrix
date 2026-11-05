/**
 * Detection and launch of the Win11 group's local apps.
 *
 * An app is installed when its command resolves on PATH (or its absolute path
 * exists). Launching uses the configured argument list, appending the project
 * directory unless the app already declares a positional argument. `.cmd` and
 * `.bat` shims go through cmd.exe, which such files require.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import type { AppSummary, Win11App } from '../shared/types.ts';
import { quoteWindowsArg, runDetached, which } from './processUtils.ts';

const CACHE_TTL_MS = 30_000;

interface CachedInstall {
  installed: boolean;
  at: number;
}

const isWindowsShim = (command: string): boolean => /\.(cmd|bat)$/i.test(command);

const launch = (
  command: string,
  args: string[],
  cwd?: string,
): { ok: boolean; error?: string } => {
  const pid = isWindowsShim(command)
    ? runDetached('cmd.exe', ['/d', '/s', '/c', [command, ...args].map(quoteWindowsArg).join(' ')], {
        cwd,
      })
    : runDetached(command, args, { cwd });
  return pid ? { ok: true } : { ok: false, error: 'spawn-failed' };
};

export class HostLauncher {
  private readonly cache = new Map<string, CachedInstall>();
  private apps: Win11App[] = [];

  setApps(apps: Win11App[]): void {
    this.apps = apps;
  }

  async detect(refresh = false): Promise<AppSummary[]> {
    const now = Date.now();
    const answers: AppSummary[] = [];
    for (const app of this.apps) {
      let cached = this.cache.get(app.id);
      if (!cached || refresh || now - cached.at > CACHE_TTL_MS) {
        cached = { installed: await which(app.command), at: now };
        this.cache.set(app.id, cached);
      }
      answers.push({
        id: app.id,
        name: app.name,
        command: app.command,
        installed: cached.installed,
        ...(app.icon ? { icon: app.icon } : {}),
      });
    }
    return answers;
  }

  async open(id: string, directory: string): Promise<{ ok: boolean; error?: string }> {
    const app = this.apps.find((candidate) => candidate.id === id);
    if (!app) return { ok: false, error: 'unknown-app' };
    if (process.env.OPENCHAMBER_OPENWITH_DRY_RUN === '1') return { ok: true };

    try {
      const stat = await fsp.stat(directory);
      if (!stat.isDirectory()) return { ok: false, error: 'not-a-directory' };
    } catch {
      return { ok: false, error: 'directory-missing' };
    }

    const apps = await this.detect();
    if (!apps.find((candidate) => candidate.id === id)?.installed) {
      return { ok: false, error: 'not-installed' };
    }

    const hasPositional = app.args.some((arg) => !arg.startsWith('-'));
    const args = hasPositional ? [...app.args] : [...app.args, directory];
    return launch(app.command, args, path.dirname(directory));
  }

  /** Launch an arbitrary command from a config entry (e.g. a ShardX profile). */
  async launchCommand(
    command: string,
    args: string[] = [],
    cwd?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (process.env.OPENCHAMBER_OPENWITH_DRY_RUN === '1') return { ok: true };
    return launch(command, args, cwd);
  }

  invalidate(): void {
    this.cache.clear();
  }
}
