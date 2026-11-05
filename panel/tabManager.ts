/**
 * Tab state for the Matrix workspace.
 *
 * The manager owns the tab list, active tab, split layout and persistence. It
 * does not touch the DOM: `main.ts` renders the strip and panes from `state()`
 * and receives `onEvict` for tabs removed by the max-tab budget or the user.
 */

import type { JsonValue, SplitLayout, TabKind, WorkspaceTab } from '../shared/types.ts';

const STORAGE_KEY = 'openwith.tabs.v2';
const KINDS: readonly TabKind[] = [
  'matrix-home',
  'guest-extension',
  'web-iframe',
  'log-stream',
  'terminal-exec',
];

export interface TabStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface TabState {
  tabs: WorkspaceTab[];
  activeId: string;
  split: SplitLayout;
}

export interface NewTab {
  kind: TabKind;
  title: string;
  icon?: string;
  payload?: Record<string, JsonValue>;
  pinned?: boolean;
  keepAlive?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const payloadOf = (value: unknown): Record<string, JsonValue> => {
  if (!isRecord(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
  } catch {
    return {};
  }
};

const sanitizeTab = (value: unknown): WorkspaceTab | null => {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (typeof kind !== 'string' || !KINDS.includes(kind as TabKind)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  return {
    id: value.id,
    kind: kind as TabKind,
    title: typeof value.title === 'string' && value.title ? value.title : '未命名标签',
    ...(typeof value.icon === 'string' && value.icon ? { icon: value.icon } : {}),
    pinned: value.pinned === true,
    keepAlive: value.keepAlive !== false,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    payload: payloadOf(value.payload),
  };
};

const sanitizeSplit = (value: unknown): SplitLayout => {
  if (!isRecord(value)) {
    return { enabled: false, direction: 'horizontal', ratio: 0.5, secondaryTabId: null };
  }
  const direction = value.direction === 'vertical' ? 'vertical' : 'horizontal';
  const ratio =
    typeof value.ratio === 'number' && value.ratio >= 0.2 && value.ratio <= 0.8 ? value.ratio : 0.5;
  return {
    enabled: value.enabled === true,
    direction,
    ratio,
    secondaryTabId: typeof value.secondaryTabId === 'string' ? value.secondaryTabId : null,
  };
};

export class TabManager {
  private state: TabState = {
    tabs: [],
    activeId: '',
    split: { enabled: false, direction: 'horizontal', ratio: 0.5, secondaryTabId: null },
  };
  private readonly listeners = new Set<() => void>();
  private saveTimer: number | null = null;
  private counter = 0;

  constructor(
    private readonly storage: TabStorage,
    private readonly maxTabs: number,
    private readonly onEvict?: (tab: WorkspaceTab) => void,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await this.storage.get(STORAGE_KEY);
      if (isRecord(raw)) {
        const tabs = Array.isArray(raw.tabs)
          ? raw.tabs.map(sanitizeTab).filter((tab): tab is WorkspaceTab => tab !== null)
          : [];
        this.state = {
          tabs,
          activeId: typeof raw.activeId === 'string' ? raw.activeId : '',
          split: sanitizeSplit(raw.split),
        };
      }
    } catch {
      /* start from the default home tab */
    }
    this.ensureHome();
    this.reconcile();
    this.emit();
  }

  getState(): TabState {
    return this.state;
  }

  activeTab(): WorkspaceTab | null {
    return this.find(this.state.activeId) ?? this.state.tabs[0] ?? null;
  }

  secondaryTab(): WorkspaceTab | null {
    const id = this.state.split.secondaryTabId;
    if (!this.state.split.enabled || !id) return null;
    return id === this.state.activeId ? null : this.find(id);
  }

  find(id: string): WorkspaceTab | null {
    return this.state.tabs.find((tab) => tab.id === id) ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  create(input: NewTab): WorkspaceTab {
    if (this.state.tabs.length >= this.maxTabs) this.evict();
    const tab: WorkspaceTab = {
      id: this.newId(input.kind),
      kind: input.kind,
      title: input.title,
      ...(input.icon ? { icon: input.icon } : {}),
      pinned: input.pinned === true,
      keepAlive: input.keepAlive !== false,
      createdAt: Date.now(),
      payload: payloadOf(input.payload ?? {}),
    };
    this.state.tabs.push(tab);
    this.state.activeId = tab.id;
    this.reconcile();
    this.persist();
    this.emit();
    return tab;
  }

  close(id: string): boolean {
    const index = this.state.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return false;
    const tab = this.state.tabs[index];
    if (!tab || tab.pinned || tab.kind === 'matrix-home') return false;
    this.state.tabs.splice(index, 1);
    this.onEvict?.(tab);
    if (this.state.activeId === id) {
      this.state.activeId =
        this.state.tabs[Math.min(index, this.state.tabs.length - 1)]?.id ?? '';
    }
    if (this.state.split.secondaryTabId === id) {
      this.state.split.secondaryTabId = null;
      this.state.split.enabled = false;
    }
    this.reconcile();
    this.persist();
    this.emit();
    return true;
  }

  activate(id: string): void {
    const tab = this.find(id);
    if (!tab || this.state.activeId === id) return;
    if (this.state.split.enabled && this.state.split.secondaryTabId === id) {
      this.state.split.secondaryTabId = this.state.activeId;
    }
    this.state.activeId = id;
    this.reconcile();
    this.persist();
    this.emit();
  }

  togglePin(id: string): void {
    const tab = this.find(id);
    if (!tab || tab.kind === 'matrix-home') return;
    tab.pinned = !tab.pinned;
    this.persist();
    this.emit();
  }

  move(id: string, toIndex: number): void {
    const from = this.state.tabs.findIndex((tab) => tab.id === id);
    if (from < 0) return;
    const [tab] = this.state.tabs.splice(from, 1);
    if (!tab) return;
    const index = Math.max(0, Math.min(this.state.tabs.length, toIndex));
    this.state.tabs.splice(index, 0, tab);
    this.persist();
    this.emit();
  }

  updatePayload(id: string, patch: Record<string, JsonValue>): void {
    const tab = this.find(id);
    if (!tab) return;
    tab.payload = { ...tab.payload, ...payloadOf(patch) };
    this.persist();
    this.emit();
  }

  setSplit(patch: Partial<SplitLayout>): void {
    const next: SplitLayout = { ...this.state.split, ...patch };
    if (next.enabled) {
      if (!next.secondaryTabId || next.secondaryTabId === this.state.activeId) {
        next.secondaryTabId =
          this.state.tabs.find((tab) => tab.id !== this.state.activeId)?.id ?? null;
      }
      if (!next.secondaryTabId) next.enabled = false;
    }
    next.ratio = Math.max(0.2, Math.min(0.8, next.ratio));
    this.state.split = next;
    this.persist();
    this.emit();
  }

  private ensureHome(): void {
    if (this.state.tabs.some((tab) => tab.kind === 'matrix-home')) return;
    this.state.tabs.unshift({
      id: 'home',
      kind: 'matrix-home',
      title: '矩阵主页',
      icon: '⌂',
      pinned: true,
      keepAlive: true,
      createdAt: Date.now(),
      payload: {},
    });
  }

  private reconcile(): void {
    if (!this.find(this.state.activeId)) {
      this.state.activeId = this.state.tabs[0]?.id ?? '';
    }
    if (
      this.state.split.secondaryTabId &&
      (!this.find(this.state.split.secondaryTabId) ||
        this.state.split.secondaryTabId === this.state.activeId)
    ) {
      this.state.split.secondaryTabId =
        this.state.tabs.find((tab) => tab.id !== this.state.activeId)?.id ?? null;
    }
    if (!this.state.split.secondaryTabId) this.state.split.enabled = false;
  }

  private evict(): void {
    const index = this.state.tabs.findIndex(
      (tab) => !tab.pinned && tab.kind !== 'matrix-home' && tab.id !== this.state.activeId,
    );
    if (index < 0) return;
    const [tab] = this.state.tabs.splice(index, 1);
    if (!tab) return;
    this.onEvict?.(tab);
    if (this.state.split.secondaryTabId === tab.id) {
      this.state.split.secondaryTabId = null;
      this.state.split.enabled = false;
    }
  }

  private newId(kind: TabKind): string {
    this.counter += 1;
    return `${kind}-${Date.now().toString(36)}-${this.counter.toString(36)}`;
  }

  private persist(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.storage.set(STORAGE_KEY, this.state).catch(() => undefined);
    }, 200);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* a render error must not break tab state */
      }
    }
  }
}
