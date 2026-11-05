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
  capabilities?: { requested?: string[]; granted?: string[] };
  service?: { runtime?: string; granted?: boolean; permissions?: { exec?: string[]; sockets?: string[] } };
}

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
  ): Promise<T> {
    const base = await this.baseUrl();
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    const guests = Array.isArray(answer.guests) ? answer.guests : [];
    return guests.map(toSummary).filter((guest) => guest.id.length > 0);
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
