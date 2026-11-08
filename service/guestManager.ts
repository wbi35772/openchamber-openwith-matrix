/**
 * Bridge to the OpenChamber host API.
 *
 * The host listens on loopback and exposes the installed guest catalog, frame
 * grants and a service-request proxy. The panel cannot call it directly (its
 * CSP only allows the guest service), so every call goes through this module.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  GuestFrameGrant,
  GuestServiceRequest,
  GuestServiceResult,
  GuestSummary,
} from '../shared/types.ts';

const SETTINGS_PATH = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
const FALLBACK_BASE = 'http://127.0.0.1:53253';
const REQUEST_TIMEOUT_MS = 15_000;

interface GuestRecord {
  id?: string;
  name?: string;
  icon?: string;
  enabled?: boolean;
  version?: string;
  source?: string;
  path?: string;
  entry?: string;
  pageEntry?: string;
  storageId?: string;
  origin?: { url?: string; ref?: string };
  update?: { version?: string };
  capabilities?: { requested?: string[]; granted?: string[] };
  service?: { runtime?: string; granted?: boolean; permissions?: { exec?: string[]; sockets?: string[] } };
}

interface GuestLocalMeta {
  repoUrl?: string;
  iconData?: string;
}

interface UpdateState {
  at: number;
  checked: boolean;
  versions: Map<string, string>;
}

const ICON_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

const MAX_ICON_BYTES = 128 * 1024;
const META_TTL_MS = 60_000;
const UPDATE_TTL_MS = 5 * 60_000;
const UPDATE_FAILURE_TTL_MS = 30_000;

const toSummary = (record: GuestRecord): GuestSummary => ({
  id: String(record.id ?? ''),
  name: String(record.name ?? record.id ?? ''),
  ...(record.icon ? { icon: record.icon } : {}),
  enabled: record.enabled !== false,
  ...(record.version ? { version: record.version } : {}),
  ...(record.source ? { source: record.source } : {}),
  ...(record.path ? { path: record.path } : {}),
  ...(record.entry ? { entry: record.entry } : {}),
  ...(record.pageEntry ? { pageEntry: record.pageEntry } : {}),
  ...(record.storageId ? { storageId: record.storageId } : {}),
  ...(record.capabilities
    ? {
        capabilities: {
          ...(record.capabilities.requested ? { requested: record.capabilities.requested } : {}),
          ...(record.capabilities.granted ? { granted: record.capabilities.granted } : {}),
        },
      }
    : {}),
  ...(record.service
    ? {
        service: {
          ...(record.service.runtime ? { runtime: record.service.runtime } : {}),
          ...(record.service.granted !== undefined ? { granted: record.service.granted } : {}),
          ...(record.service.permissions ? { permissions: record.service.permissions } : {}),
        },
      }
    : {}),
});

export class GuestManager {
  private cachedBase: string | null = null;
  private readonly metaCache = new Map<string, { at: number; value: GuestLocalMeta }>();
  private updateCache: UpdateState | null = null;

  constructor(private readonly log: (message: string) => void) {}

  /** Host origin: agent-tool URL, then the desktop settings port, then 53253. */
  async baseUrl(): Promise<string> {
    if (this.cachedBase) return this.cachedBase;
    const agentUrl = process.env.OPENCHAMBER_AGENT_TOOL_URL;
    if (agentUrl) {
      try {
        this.cachedBase = new URL(agentUrl).origin;
        return this.cachedBase;
      } catch {
        /* fall through */
      }
    }
    try {
      const text = await fsp.readFile(SETTINGS_PATH, 'utf8');
      const settings = JSON.parse(text) as { desktopLocalPort?: number };
      if (typeof settings.desktopLocalPort === 'number' && settings.desktopLocalPort > 0) {
        this.cachedBase = `http://127.0.0.1:${settings.desktopLocalPort}`;
        return this.cachedBase;
      }
    } catch {
      /* settings not readable */
    }
    this.cachedBase = FALLBACK_BASE;
    return this.cachedBase;
  }

  private async request<T>(
    method: string,
    route: string,
    body?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const base = await this.baseUrl();
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      const message = `host ${method} ${route} -> ${response.status}: ${text.slice(0, 300)}`;
      this.log(`guest bridge: ${message}`);
      throw new Error(message);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async list(): Promise<GuestSummary[]> {
    const answer = await this.request<{ guests?: GuestRecord[] }>('GET', '/api/guests');
    const records = Array.isArray(answer.guests) ? answer.guests : [];
    const updates: UpdateState = this.updateCache?.checked
      ? this.updateCache
      : { at: 0, checked: false, versions: new Map() };
    const metas = await Promise.all(records.map((record) => this.localMeta(record)));

    return records
      .map((record, index) => {
        const summary = toSummary(record);
        const meta = metas[index] ?? {};
        const originUrl = record.origin?.url?.trim();
        const latestVersion = updates.versions.get(summary.id) ?? record.update?.version?.trim();
        return {
          ...summary,
          ...(originUrl ? { originUrl } : {}),
          ...(meta.repoUrl ? { repoUrl: meta.repoUrl } : {}),
          ...(meta.iconData ? { iconData: meta.iconData } : {}),
          ...(latestVersion ? { latestVersion } : {}),
          ...(originUrl
            ? { updateChecked: updates.checked || Boolean(record.update?.version) }
            : {}),
        };
      })
      .filter((guest) => guest.id.length > 0);
  }

  /** Resolve package.json metadata and a file-based panel icon into a data URL. */
  private async localMeta(record: GuestRecord): Promise<GuestLocalMeta> {
    const dir = record.path?.trim();
    if (!dir) return {};

    const cached = this.metaCache.get(dir);
    if (cached && Date.now() - cached.at < META_TTL_MS) return cached.value;

    const value: GuestLocalMeta = {};
    let iconName = record.icon?.trim();

    try {
      const text = await fsp.readFile(path.join(dir, 'package.json'), 'utf8');
      const pkg = JSON.parse(text) as {
        repository?: string | { url?: string };
        openchamber?: { contributes?: { panel?: { icon?: string } } };
      };
      const repository = pkg.repository;
      const repoUrl = typeof repository === 'string' ? repository : repository?.url;
      if (repoUrl?.trim()) value.repoUrl = repoUrl.trim();
      iconName = iconName || pkg.openchamber?.contributes?.panel?.icon?.trim();
    } catch {
      /* package.json is optional for the local metadata */
    }

    if (iconName && /[./\\]/.test(iconName)) {
      const baseDir = path.resolve(dir);
      const file = path.resolve(baseDir, iconName);
      const relative = path.relative(baseDir, file);
      const extension = path.extname(file).toLowerCase();
      const mime = ICON_MIME[extension];
      if (mime && relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        try {
          const buffer = await fsp.readFile(file);
          if (buffer.byteLength > 0 && buffer.byteLength <= MAX_ICON_BYTES) {
            value.iconData = `data:${mime};base64,${buffer.toString('base64')}`;
          }
        } catch {
          /* icon file missing or unreadable: the panel falls back to a glyph */
        }
      }
    }

    this.metaCache.set(dir, { at: Date.now(), value });
    return value;
  }

  private async updates(force: boolean): Promise<UpdateState> {
    const ttl = this.updateCache?.checked ? UPDATE_TTL_MS : UPDATE_FAILURE_TTL_MS;
    if (!force && this.updateCache && Date.now() - this.updateCache.at < ttl) {
      return this.updateCache;
    }

    try {
      const answer = await this.request<{
        updates?: Record<string, { version?: string }>;
      }>('POST', '/api/guests/updates/check', { force }, 60_000);
      const versions = new Map<string, string>();
      for (const [id, entry] of Object.entries(answer.updates ?? {})) {
        const version = entry?.version?.trim();
        if (version) versions.set(id, version);
      }
      this.updateCache = { at: Date.now(), checked: true, versions };
    } catch (error) {
      this.log(
        `guest update check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.updateCache = { at: Date.now(), checked: false, versions: new Map() };
    }
    return this.updateCache;
  }

  /** Force a host update check and return the guests with a newer version. */
  async checkUpdates(force = true): Promise<Record<string, string>> {
    const state = await this.updates(force);
    return Object.fromEntries(state.versions);
  }

  /** Update one guest through the host, then invalidate cached metadata. */
  async update(id: string): Promise<unknown> {
    const result = await this.request(
      'POST',
      `/api/guests/${encodeURIComponent(id)}/update`,
      undefined,
      180_000,
    );
    this.updateCache = null;
    this.metaCache.clear();
    return result;
  }

  async frameGrant(id: string, entry = 'panel/index.html'): Promise<GuestFrameGrant> {
    const grant = await this.request<{ grant?: string; expiresAt?: number }>(
      'POST',
      `/api/guests/${encodeURIComponent(id)}/frame-grant`,
      {},
    );
    if (!grant.grant) throw new Error('host returned no frame grant');
    const base = await this.baseUrl();
    return {
      grant: grant.grant,
      expiresAt: Number(grant.expiresAt ?? Date.now() + 60_000),
      url: `${base}/api/guest-files/${grant.grant}/${entry.replace(/^\/+/, '')}`,
    };
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.request('PUT', `/api/guests/${encodeURIComponent(id)}/enabled`, { enabled });
  }

  async serviceRequest(id: string, request: GuestServiceRequest): Promise<GuestServiceResult> {
    const body =
      typeof request.body === 'string'
        ? request.body
        : request.body === undefined
          ? undefined
          : JSON.stringify(request.body);
    const answer = await this.request<{ status?: number; body?: string }>(
      'POST',
      `/api/guests/${encodeURIComponent(id)}/service/request`,
      {
        method: request.method,
        path: request.path,
        ...(request.query ? { query: request.query } : {}),
        ...(body !== undefined ? { body } : {}),
      },
    );
    return {
      status: Number(answer.status ?? 0),
      body: typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? ''),
    };
  }

  async storage(id: string, body: unknown): Promise<unknown> {
    return this.request('POST', `/api/guests/${encodeURIComponent(id)}/storage`, body);
  }
}
