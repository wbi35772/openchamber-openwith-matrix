/**
 * Configuration store for OpenWith Matrix.
 *
 * Defaults ship in `config/default-matrix.json` (copied into `dist/config/` by
 * the build). The user's edits live in
 * `~/.config/openchamber/openwith-matrix.json`; that file is merged over the
 * defaults on load, so an upgrade can add new groups without losing the old
 * settings. Writes are atomic: a crash never leaves a half-written config.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  DEFAULT_HOME_SECTIONS,
  type HomeSectionConfig,
  type HomeSectionKind,
  type HomeViewMode,
  type JsonValue,
  type MatrixConfig,
} from '../shared/types.ts';

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'openchamber');
export const CONFIG_PATH = path.join(CONFIG_DIR, CONFIG_FILE_NAME);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Merge `patch` over `base`: objects recurse, arrays and scalars replace. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (Array.isArray(patch)) return patch as unknown as T;
  if (isRecord(base) && isRecord(patch)) {
    const next: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = key in next ? deepMerge(next[key], value) : value;
    }
    return next as unknown as T;
  }
  return patch as T;
}

const DEFAULT_CONFIG_FILE = 'default-matrix.json';

const defaultCandidates = (): string[] => [
  path.join(import.meta.dirname, '..', 'config', DEFAULT_CONFIG_FILE),
  path.join(import.meta.dirname, '..', '..', 'config', DEFAULT_CONFIG_FILE),
  path.join(process.cwd(), 'config', DEFAULT_CONFIG_FILE),
  path.join(import.meta.dirname, '..', 'config', CONFIG_FILE_NAME),
  path.join(import.meta.dirname, '..', '..', 'config', CONFIG_FILE_NAME),
  path.join(process.cwd(), 'config', CONFIG_FILE_NAME),
];

const readJsonFile = async (file: string): Promise<unknown> => {
  const text = await fsp.readFile(file, 'utf8');
  return JSON.parse(text) as unknown;
};

const loadDefaults = async (): Promise<MatrixConfig> => {
  const errors: string[] = [];
  for (const candidate of defaultCandidates()) {
    try {
      const parsed = await readJsonFile(candidate);
      if (isRecord(parsed)) return parsed as unknown as MatrixConfig;
      errors.push(`${candidate}: not an object`);
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`default config not found (${errors.join('; ')})`);
};

const HOME_SECTION_KINDS: HomeSectionKind[] = [
  'guests',
  'win11-apps',
  'shardx',
  'wsl-ports',
  'docker-containers',
  'k8s-forwards',
  'cloud-bookmarks',
  'cloud-webhooks',
  'custom-group',
];

const HOME_VIEW_MODES: HomeViewMode[] = ['list', 'cards', 'compact'];

const defaultSectionFor = (kind: HomeSectionKind): HomeSectionConfig | undefined =>
  DEFAULT_HOME_SECTIONS.find((section) => section.kind === kind);

const uniqueSectionId = (wanted: string, seen: Set<string>): string => {
  if (!seen.has(wanted)) {
    seen.add(wanted);
    return wanted;
  }
  let index = 2;
  while (seen.has(`${wanted}-${index}`)) index += 1;
  const id = `${wanted}-${index}`;
  seen.add(id);
  return id;
};

const normalizeSections = (
  raw: unknown,
  groups: MatrixConfig['home']['groups'],
): HomeSectionConfig[] => {
  const seen = new Set<string>();
  const sections: HomeSectionConfig[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isRecord(entry)) continue;
    const kind = HOME_SECTION_KINDS.find((value) => value === entry.kind);
    if (!kind) continue;
    const fallback = defaultSectionFor(kind);
    const groupId =
      kind === 'custom-group' && typeof entry.groupId === 'string' && entry.groupId.trim()
        ? entry.groupId.trim()
        : undefined;
    if (kind === 'custom-group' && !groupId) continue;
    const label =
      typeof entry.label === 'string' && entry.label.trim()
        ? entry.label.trim()
        : fallback?.label ?? kind;
    const view = HOME_VIEW_MODES.find((value) => value === entry.view) ?? fallback?.view ?? 'list';
    sections.push({
      id: uniqueSectionId(
        typeof entry.id === 'string' && entry.id.trim()
          ? entry.id.trim()
          : fallback?.id ?? `section-${kind}`,
        seen,
      ),
      kind,
      label,
      view,
      visible: entry.visible !== false,
      ...(entry.removed === true ? { removed: true } : {}),
      ...(groupId ? { groupId } : {}),
    });
  }

  for (const fallback of DEFAULT_HOME_SECTIONS) {
    if (sections.some((section) => section.kind === fallback.kind)) continue;
    sections.push({
      ...fallback,
      id: uniqueSectionId(fallback.id, seen),
    });
  }

  const knownGroups = new Set(groups.map((group) => group.id));
  const kept = sections.filter(
    (section) => section.kind !== 'custom-group' || (section.groupId && knownGroups.has(section.groupId)),
  );
  for (const group of groups) {
    const existing = kept.find(
      (section) => section.kind === 'custom-group' && section.groupId === group.id,
    );
    if (existing) {
      existing.label = group.name || existing.label;
      continue;
    }
    kept.push({
      id: uniqueSectionId(`group:${group.id}`, seen),
      kind: 'custom-group',
      label: group.name || '自定义分组',
      view: 'cards',
      visible: true,
      groupId: group.id,
    });
  }
  return kept;
};

/** Keep a merged config structurally usable even if the user file is partial. */
const normalize = (config: MatrixConfig): MatrixConfig => {
  const next = config;
  next.version = CONFIG_VERSION;
  next.settings ??= {} as MatrixConfig['settings'];
  next.groups ??= {} as MatrixConfig['groups'];
  next.home ??= { pageSize: 8, groups: [], sections: [] };
  if (!Array.isArray(next.home.groups)) next.home.groups = [];
  next.home.groups = next.home.groups
    .filter(isRecord)
    .map((group, groupIndex) => ({
      id:
        typeof group.id === 'string' && group.id.trim()
          ? group.id.trim()
          : `group-${groupIndex + 1}`,
      name: typeof group.name === 'string' && group.name.trim() ? group.name.trim() : '未命名分组',
      items: Array.isArray(group.items)
        ? group.items.filter(isRecord).map((item, itemIndex) => ({
            id:
              typeof item.id === 'string' && item.id.trim()
                ? item.id.trim()
                : `item-${groupIndex + 1}-${itemIndex + 1}`,
            kind:
              item.kind === 'guest' || item.kind === 'app' || item.kind === 'bookmark'
                ? item.kind
                : 'url',
            ref: typeof item.ref === 'string' ? item.ref : '',
            ...(typeof item.label === 'string' && item.label.trim()
              ? { label: item.label.trim() }
              : {}),
            ...(typeof item.icon === 'string' && item.icon.trim() ? { icon: item.icon.trim() } : {}),
          }))
        : [],
    }));
  next.home.sections = normalizeSections(next.home.sections, next.home.groups);
  if (
    typeof next.home.pageSize !== 'number' ||
    !Number.isFinite(next.home.pageSize) ||
    next.home.pageSize < 3
  ) {
    next.home.pageSize = 8;
  }

  const groups = next.groups;
  groups.guests ??= { enabled: true, order: [], hidden: [] };
  groups.win11 ??= { apps: [], shardx: [] };
  groups.wsl ??= { distros: [], ports: [] };
  groups.docker ??= { enabled: true, composeFiles: [], containers: [] };
  groups.k8s ??= { enabled: true, contexts: [], portForwards: [] };
  groups.cloud ??= { bookmarks: [], webhooks: [] };

  for (const key of ['apps', 'shardx'] as const) {
    if (!Array.isArray(groups.win11[key])) groups.win11[key] = [];
  }
  if (!Array.isArray(groups.guests.order)) groups.guests.order = [];
  if (!Array.isArray(groups.guests.hidden)) groups.guests.hidden = [];
  if (!Array.isArray(groups.wsl.distros)) groups.wsl.distros = [];
  if (!Array.isArray(groups.wsl.ports)) groups.wsl.ports = [];
  if (!Array.isArray(groups.docker.composeFiles)) groups.docker.composeFiles = [];
  if (!Array.isArray(groups.docker.containers)) groups.docker.containers = [];
  if (!Array.isArray(groups.k8s.contexts)) groups.k8s.contexts = [];
  if (!Array.isArray(groups.k8s.portForwards)) groups.k8s.portForwards = [];
  if (!Array.isArray(groups.cloud.bookmarks)) groups.cloud.bookmarks = [];
  if (!Array.isArray(groups.cloud.webhooks)) groups.cloud.webhooks = [];
  if (!Array.isArray(next.settings.logSources)) next.settings.logSources = [];
  return next;
};

export class ConfigStore {
  private current: MatrixConfig | null = null;
  private defaults: MatrixConfig | null = null;
  private readonly listeners = new Set<(config: MatrixConfig) => void>();

  async init(): Promise<MatrixConfig> {
    this.defaults = await loadDefaults();
    let user: unknown = undefined;
    try {
      user = await readJsonFile(CONFIG_PATH);
    } catch {
      user = undefined;
    }
    const merged = deepMerge(structuredClone(this.defaults), user);
    this.current = normalize(merged);
    if (user === undefined) {
      await this.persist(this.current);
    }
    return this.current;
  }

  get(): MatrixConfig {
    if (!this.current) throw new Error('config store not initialised');
    return this.current;
  }

  onChange(listener: (config: MatrixConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async save(patch: unknown): Promise<MatrixConfig> {
    const base = this.get();
    const merged = normalize(deepMerge(structuredClone(base), patch));
    this.current = merged;
    await this.persist(merged);
    for (const listener of this.listeners) {
      try {
        listener(merged);
      } catch {
        /* a listener must not break saving */
      }
    }
    return merged;
  }

  async reset(): Promise<MatrixConfig> {
    if (!this.defaults) throw new Error('config store not initialised');
    const next = normalize(structuredClone(this.defaults));
    this.current = next;
    await this.persist(next);
    return next;
  }

  private async persist(config: MatrixConfig): Promise<void> {
    await fsp.mkdir(CONFIG_DIR, { recursive: true });
    const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
    const text = `${JSON.stringify(config, null, 2)}\n`;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, CONFIG_PATH);
  }
}

/** Deep-clone a JSON value so callers cannot mutate the store by accident. */
export const cloneJson = <T>(value: T): T => structuredClone(value) as T;

/** Narrow an unknown JSON body to an object. */
export const asJsonObject = (value: unknown): Record<string, JsonValue> | null =>
  isRecord(value) ? (value as Record<string, JsonValue>) : null;
