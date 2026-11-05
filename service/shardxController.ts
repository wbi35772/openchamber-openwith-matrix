/**
 * ShardX browser-profile group.
 *
 * ShardX exposes a local automation API (default `http://127.0.0.1:40325`).
 * The panel gets a fixed 31-slot grid: each slot maps to a profile either by
 * explicit `profileId` in the config or by its position in the profile list.
 * When the launcher is not running the grid still renders, with the launcher
 * one click away.
 */

import fsp from 'node:fs/promises';

import type {
  ShardxInstance,
  ShardxProfile,
  ShardxRunning,
  ShardxSettings,
  ShardxSnapshot,
  ShardxInstanceConfig,
} from '../shared/types.ts';
import { runDetached } from './processUtils.ts';

const REQUEST_TIMEOUT_MS = 6000;

const asArray = <T>(value: unknown, key: string): T[] => {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const nested = (value as Record<string, unknown>)[key];
    if (Array.isArray(nested)) return nested as T[];
  }
  return [];
};

export class ShardxController {
  private token(settings: ShardxSettings): string {
    return process.env[settings.tokenEnv] ?? process.env.SHARDX_TOKEN ?? '';
  }

  private async api<T>(settings: ShardxSettings, route: string, init?: RequestInit): Promise<T> {
    const base = settings.apiBase.replace(/\/+$/, '');
    const token = this.token(settings);
    const response = await fetch(`${base}${route}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${init?.method ?? 'GET'} ${route} -> ${response.status}: ${text.slice(0, 200)}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  async snapshot(settings: ShardxSettings, slots: ShardxInstanceConfig[]): Promise<ShardxSnapshot> {
    let profiles: ShardxProfile[] = [];
    let running: ShardxRunning[] = [];
    let error: string | undefined;
    try {
      const [profileAnswer, runningAnswer] = await Promise.all([
        this.api<unknown>(settings, '/profiles'),
        this.api<unknown>(settings, '/running'),
      ]);
      profiles = asArray<ShardxProfile>(profileAnswer, 'profiles');
      running = asArray<ShardxRunning>(runningAnswer, 'running');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    const byProfile = new Map(running.map((entry) => [entry.profile_id, entry]));
    const instances: ShardxInstance[] = slots.map((slot, index) => {
      const profile = slot.profileId
        ? profiles.find((candidate) => candidate.profile_id === slot.profileId)
        : profiles[index];
      const profileId = profile?.profile_id ?? slot.profileId ?? null;
      const live = profileId ? byProfile.get(profileId) : undefined;
      const cdpUrl = live?.cdp?.http_url;
      return {
        id: slot.id,
        index,
        name: slot.name || profile?.name || `ShardX ${index + 1}`,
        profileId,
        running: Boolean(live),
        ...(cdpUrl ? { cdpUrl } : {}),
        ...(slot.folder || profile?.folder ? { folder: slot.folder ?? profile?.folder } : {}),
      };
    });

    return {
      online: error === undefined,
      apiBase: settings.apiBase,
      profiles,
      running,
      instances,
      expected: Math.max(settings.profileCount, slots.length),
      ...(error ? { error } : {}),
    };
  }

  async launch(settings: ShardxSettings): Promise<{ ok: boolean; error?: string }> {
    try {
      await fsp.access(settings.launcherPath);
    } catch {
      return { ok: false, error: 'launcher-missing' };
    }
    if (process.env.OPENCHAMBER_OPENWITH_DRY_RUN === '1') return { ok: true };
    const pid = runDetached(settings.launcherPath, []);
    return pid ? { ok: true } : { ok: false, error: 'spawn-failed' };
  }

  async start(
    settings: ShardxSettings,
    slots: ShardxInstanceConfig[],
    instanceId: string,
    headless = false,
  ): Promise<{ ok: boolean; error?: string; profileId?: string }> {
    const instance = slots.find((slot) => slot.id === instanceId);
    if (!instance) return { ok: false, error: 'unknown-instance' };
    const profileId =
      instance.profileId ??
      (await this.snapshot(settings, slots)).instances.find((item) => item.id === instanceId)
        ?.profileId ??
      null;
    if (!profileId) return { ok: false, error: 'profile-not-found' };
    try {
      await this.api(settings, `/profiles/${encodeURIComponent(profileId)}/start`, {
        method: 'POST',
        body: JSON.stringify({ headless }),
      });
      return { ok: true, profileId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async stop(
    settings: ShardxSettings,
    slots: ShardxInstanceConfig[],
    instanceId: string,
  ): Promise<{ ok: boolean; error?: string; profileId?: string }> {
    const instance = slots.find((slot) => slot.id === instanceId);
    if (!instance) return { ok: false, error: 'unknown-instance' };
    const profileId =
      instance.profileId ??
      (await this.snapshot(settings, slots)).instances.find((item) => item.id === instanceId)
        ?.profileId ??
      null;
    if (!profileId) return { ok: false, error: 'profile-not-found' };
    try {
      await this.api(settings, `/profiles/${encodeURIComponent(profileId)}/stop`, {
        method: 'POST',
      });
      return { ok: true, profileId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
