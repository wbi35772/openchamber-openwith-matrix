/**
 * Matrix panel shell.
 *
 * Owns the tab strip, the keep-alive panes, split layout and every call to the
 * guest service. The panel itself is sandboxed, so all privileged work goes
 * through `host.serviceRequest`; only the tab shell lives here.
 */

import { connectHost } from '@openchamber/sdk';
import type { HostClient, HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

import type {
  AppSummary,
  BrowserFrame,
  BrowserInput,
  BrowserSessionInfo,
  CloudBookmark,
  DockerContainer,
  GuestFrameGrant,
  GuestServiceResult,
  GuestSummary,
  HomeSectionConfig,
  HomeViewMode,
  JsonValue,
  LogOutput,
  LogSourceInfo,
  LogSubscriptionInfo,
  MatrixConfig,
  MatrixSnapshot,
  ShardxInstance,
  TabKind,
  TerminalExecResult,
  TerminalShell,
  WebhookResult,
  WorkspaceTab,
} from '../shared/types.ts';
import { badge, button, clear, errorText, h } from './dom.ts';
import { TabManager } from './tabManager.ts';
import { mountHome, type HomeActions, type HomeState } from './views/matrixHomeView.ts';
import { createLogPane, type LogPaneHandle } from './views/logStreamView.ts';
import { openConfigModal } from './views/configModalView.ts';
import { openHomeGroups } from './views/homeGroupsView.ts';
import { openHomeTabs } from './views/homeTabsView.ts';
import { openResourceEditor, type ResourceSection } from './views/resourceEditorView.ts';
import { createGuestBridge, type GuestBridge } from './guestBridge.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface PaneRecord {
  el: HTMLElement;
  cleanup?: () => void;
}

interface Shell {
  root: HTMLElement;
  strip: HTMLElement;
  body: HTMLElement;
  status: HTMLElement;
  splitControls: HTMLElement;
  splitButton: HTMLButtonElement;
  divider: HTMLElement;
  newButton: HTMLButtonElement;
}

const host: HostClient = connectHost();

let ready: HostReadyContext | null = null;
let config: MatrixConfig | null = null;
let configPath = '';
let snapshot: MatrixSnapshot | null = null;
let logSources: LogSourceInfo[] = [];
let homeState: HomeState = { snapshot: null, loading: true, error: null, directory: null };
let tabs: TabManager | null = null;
let shell: Shell | null = null;
let refreshing = false;
let tabMenu: HTMLElement | null = null;
let toastTimer: number | null = null;

const panes = new Map<string, PaneRecord>();

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const service = async (
  method: Method,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> => {
  const result = await host.serviceRequest({
    method,
    path,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: unknown = {};
  if (result.body) {
    try {
      parsed = JSON.parse(result.body) as unknown;
    } catch {
      parsed = { raw: result.body };
    }
  }
  const record =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  if (result.status >= 400 || record.ok === false) {
    throw new Error(String(record.error ?? record.detail ?? `HTTP ${result.status}`));
  }
  return record;
};

const request = async <T>(method: Method, path: string, body?: unknown): Promise<T> => {
  const answer = await service(method, path, body);
  return ('data' in answer ? answer.data : answer) as T;
};

const notify = (text: string, tone: 'ok' | 'error' | 'info' = 'info'): void => {
  let el = document.getElementById('ow-toast');
  if (!el) {
    el = h('div', { class: 'toast', attrs: { id: 'ow-toast' } });
    document.body.append(el);
  }
  el.textContent = text;
  el.className = `toast ${tone}`;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    document.getElementById('ow-toast')?.remove();
  }, 4200);
};

const normalizeUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

const iconFor = (kind: TabKind): string => {
  switch (kind) {
    case 'matrix-home':
      return '⌂';
    case 'guest-extension':
      return '▣';
    case 'web-iframe':
      return '◍';
    case 'log-stream':
      return '≡';
    default:
      return '>_';
  }
};

const tabGlyph = (tab: WorkspaceTab): string => {
  const icon = tab.icon?.trim() ?? '';
  if (icon && icon.length <= 2 && !/[./\\]/.test(icon)) return icon;
  if (tab.kind === 'guest-extension') return Array.from(tab.title.trim())[0] ?? '▣';
  return iconFor(tab.kind);
};

const openWeb = (url: string, title: string): void => {
  const target = normalizeUrl(url);
  if (!target) return;
  tabs?.create({
    kind: 'web-iframe',
    title: title.trim() || target,
    icon: '◍',
    payload: { url: target },
  });
};

const guestGlyph = (guest: GuestSummary): string => {
  const icon = guest.icon?.trim() ?? '';
  if (icon && icon.length <= 2 && !/[./\\]/.test(icon)) return icon;
  return Array.from(guest.name.trim())[0] ?? '▣';
};

const openGuest = (guest: GuestSummary): void => {
  tabs?.create({
    kind: 'guest-extension',
    title: guest.name,
    icon: guestGlyph(guest),
    payload: { guestId: guest.id },
  });
};

const openLogs = (): void => {
  tabs?.create({ kind: 'log-stream', title: '日志流', icon: '≡', payload: {} });
};

const openTerminal = (): void => {
  tabs?.create({
    kind: 'terminal-exec',
    title: '终端',
    icon: '>_',
    payload: { shell: config?.settings.terminalShell ?? 'powershell' },
  });
};

const runAction = async (label: string, work: () => Promise<unknown>): Promise<void> => {
  try {
    await work();
    notify(`${label} 完成`, 'ok');
  } catch (error) {
    notify(`${label} 失败：${messageOf(error)}`, 'error');
  } finally {
    void refreshSnapshot(false);
  }
};

const homeActions: HomeActions = {
  rerender: () => renderHome(),
  openManageMenu: (anchor) => openHomeManageMenu(anchor),
  editGroups: () => openHomeGroupsEditor(),
  editTabs: () => openHomeTabsEditor(),
  editResources: (section) => openResources(section),
  setHomeView: (sectionId, view) => setHomeView(sectionId, view),
  moveHomeSection: (sectionId, beforeId) => moveHomeSection(sectionId, beforeId),
  openGuest,
  toggleGuest: (guest, enabled) => {
    void runAction(`${enabled ? '启用' : '禁用'} ${guest.name}`, () =>
      request('PUT', `/guests/${encodeURIComponent(guest.id)}/enabled`, { enabled }),
    );
  },
  openApp: (app: AppSummary) => {
    const directory = ready?.directory ?? '';
    if (!directory) {
      notify('没有打开的项目目录', 'error');
      return;
    }
    void runAction(`启动 ${app.name}`, () =>
      request('POST', `/apps/${encodeURIComponent(app.id)}/open`, { directory }),
    );
  },
  openWeb,
  openBookmark: (bookmark: CloudBookmark) => {
    void (async () => {
      try {
        const answer = await request<{ value: string }>('POST', '/variables/expand', {
          template: bookmark.url,
          path: ready?.directory,
        });
        const url = answer.value || bookmark.url;
        if (bookmark.openIn === 'host') {
          await host.openUrl(url);
        } else {
          openWeb(url, bookmark.name);
        }
      } catch (error) {
        notify(`打开书签失败：${messageOf(error)}`, 'error');
      }
    })();
  },
  runWebhook: (id, name) => {
    void runAction(`Webhook ${name}`, async () => {
      const result = await request<WebhookResult>('POST', `/webhooks/${encodeURIComponent(id)}/run`, {
        path: ready?.directory,
      });
      if (!result.ok) throw new Error(result.error ?? `HTTP ${result.status}`);
    });
  },
  shardxLaunch: () => {
    void runAction('启动 ShardX', () => request('POST', '/shardx/launch'));
  },
  shardxStart: (instance: ShardxInstance) => {
    void runAction(`启动 ${instance.name}`, () =>
      request('POST', `/shardx/${encodeURIComponent(instance.id)}/start`, { headless: true }),
    );
  },
  shardxStop: (instance: ShardxInstance) => {
    void runAction(`停止 ${instance.name}`, () =>
      request('POST', `/shardx/${encodeURIComponent(instance.id)}/stop`),
    );
  },
  dockerAction: (container: DockerContainer, action) => {
    void runAction(`${action} ${container.name}`, () =>
      request('POST', `/docker/containers/${encodeURIComponent(container.id)}/${action}`),
    );
  },
  dockerCompose: (action) => {
    void runAction(`docker compose ${action}`, () => request('POST', `/docker/compose/${action}`));
  },
  k8sForward: (input) => {
    void runAction('创建端口转发', () => request('POST', '/k8s/forward', input));
  },
  k8sStopForward: (id) => {
    void runAction('停止端口转发', () =>
      request('DELETE', `/k8s/forward/${encodeURIComponent(id)}`),
    );
  },
};

const createGuestPane = (tab: WorkspaceTab): PaneRecord => {
  const el = h('div', { class: 'pane guest-pane' });
  const frame = h('iframe', { class: 'guest-frame', attrs: { title: tab.title } });
  const status = h('span', { class: 'pane-status', text: '获取访问授权…' });
  const guestId = String(tab.payload.guestId ?? '');
  const body = h('div', { class: 'pane-body guest-body' });
  let timer: number | null = null;
  let grantUrl = '';
  let bridge: GuestBridge | null = null;

  const load = async (): Promise<void> => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    bridge?.dispose();
    bridge = null;
    status.textContent = '获取访问授权…';
    try {
      const grant = await request<GuestFrameGrant>(
        'POST',
        `/guests/${encodeURIComponent(guestId)}/frame-grant`,
        { entry: 'panel/index.html' },
      );
      grantUrl = grant.url;
      bridge = createGuestBridge({
        frame,
        ready: () => ready,
        host,
        serviceRequest: (payload) =>
          request<GuestServiceResult>(
            'POST',
            `/guests/${encodeURIComponent(guestId)}/service-request`,
            payload,
          ),
        storage: (payload) =>
          request<unknown>('POST', `/guests/${encodeURIComponent(guestId)}/storage`, payload),
        close: () => closeTab(tab.id),
        onStatus: (text) => {
          status.textContent = text;
        },
      });
      frame.src = grant.url;
      status.textContent = '加载扩展…';
      const ttl = Math.max(5000, grant.expiresAt - Date.now() - 5000);
      timer = window.setTimeout(() => void load(), Math.min(ttl, 4 * 60_000));
    } catch (error) {
      status.textContent = `无法嵌入：${messageOf(error)}`;
      if (!body.querySelector('.pane-empty')) {
        body.append(
          h('div', { class: 'pane-empty' }, [
            errorText('宿主未授权嵌入时，请使用“在宿主中打开”。'),
          ]),
        );
      }
    }
  };

  const toolbar = h('div', { class: 'pane-toolbar' }, [
    h('strong', { class: 'pane-title', text: tab.title }),
    status,
    h('span', { class: 'spacer' }),
    button('刷新', () => void load()),
    button('在宿主中打开', () => {
      if (grantUrl) void host.openUrl(grantUrl);
    }),
  ]);

  frame.addEventListener('load', () => {
    status.textContent = '扩展已加载';
    bridge?.sendReady();
    window.setTimeout(() => bridge?.sendReady(), 250);
  });

  el.append(toolbar, body);
  if (guestId.toLowerCase() === 'openwith') {
    status.textContent = '已阻止递归嵌入';
    body.append(
      h('div', { class: 'pane-empty' }, [
        h('strong', { text: '不能把 OpenWith 自身嵌入标签页' }),
        h('p', { text: '请从宿主扩展菜单打开其他扩展。' }),
      ]),
    );
    return { el };
  }

  body.append(frame);
  void load();
  return {
    el,
    cleanup: () => {
      if (timer !== null) window.clearTimeout(timer);
      bridge?.dispose();
      bridge = null;
      frame.src = 'about:blank';
    },
  };
};

const createWebPane = (tab: WorkspaceTab): PaneRecord => {
  const el = h('div', { class: 'pane web-pane' });
  const image = h('img', {
    class: 'browser-frame',
    attrs: { alt: tab.title, draggable: 'false' },
  });
  image.tabIndex = 0;
  const status = h('span', { class: 'pane-status', text: '启动无头浏览器…' });
  const urlInput = h('input', {
    class: 'input',
    attrs: { type: 'url', value: String(tab.payload.url ?? ''), spellcheck: 'false' },
  });
  const viewport = h('div', { class: 'browser-viewport', attrs: { tabindex: '0' } }, [image]);
  let sessionId: string | null = null;
  let seq = 0;
  let timer: number | null = null;
  let destroyed = false;
  let frameWidth = 0;
  let frameHeight = 0;
  let lastMove = 0;

  const send = (input: BrowserInput): void => {
    if (!sessionId) return;
    void request('POST', `/browser/sessions/${encodeURIComponent(sessionId)}/input`, {
      input,
    }).catch(() => undefined);
  };

  const point = (event: MouseEvent): { x: number; y: number } => {
    const rect = viewport.getBoundingClientRect();
    const sourceWidth = frameWidth || rect.width || 1;
    const sourceHeight = frameHeight || rect.height || 1;
    const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight) || 1;
    const offsetX = (rect.width - sourceWidth * scale) / 2;
    const offsetY = (rect.height - sourceHeight * scale) / 2;
    return {
      x: Math.max(
        0,
        Math.min(sourceWidth, Math.round((event.clientX - rect.left - offsetX) / scale)),
      ),
      y: Math.max(
        0,
        Math.min(sourceHeight, Math.round((event.clientY - rect.top - offsetY) / scale)),
      ),
    };
  };

  let lastClick = 0;
  let clickCount = 1;
  image.addEventListener('click', (event) => {
    const now = Date.now();
    clickCount = now - lastClick < 400 ? Math.min(clickCount + 1, 3) : 1;
    lastClick = now;
    send({ type: 'mouse', action: 'click', ...point(event), button: 'left', clickCount });
  });
  image.addEventListener('mousemove', (event) => {
    const now = Date.now();
    if (now - lastMove < 60) return;
    lastMove = now;
    send({ type: 'mouse', action: 'move', ...point(event) });
  });
  image.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      send({
        type: 'mouse',
        action: 'wheel',
        ...point(event),
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
    },
    { passive: false },
  );

  const modifiersOf = (event: KeyboardEvent): number =>
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0);

  viewport.addEventListener('keydown', (event) => {
    event.preventDefault();
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
    send({
      type: 'key',
      action: 'down',
      key: event.key,
      code: event.code,
      modifiers: modifiersOf(event),
      ...(printable ? { text: event.key } : {}),
    });
  });
  viewport.addEventListener('keyup', (event) => {
    event.preventDefault();
    send({
      type: 'key',
      action: 'up',
      key: event.key,
      code: event.code,
      modifiers: modifiersOf(event),
    });
  });

  const poll = async (): Promise<void> => {
    if (destroyed || !sessionId) return;
    let delay = 60;
    try {
      const frame = await request<BrowserFrame | null>(
        'GET',
        `/browser/sessions/${encodeURIComponent(sessionId)}/frame?since=${seq}&wait=1200`,
      );
      if (frame && frame.seq > seq) {
        seq = frame.seq;
        frameWidth = frame.width;
        frameHeight = frame.height;
        image.src = `data:${frame.mime};base64,${frame.data}`;
        status.textContent = `${frame.width}×${frame.height} · #${frame.seq}`;
      }
    } catch (error) {
      status.textContent = messageOf(error);
      delay = 1500;
    }
    if (!destroyed) timer = window.setTimeout(() => void poll(), delay);
  };

  const start = async (target: string): Promise<void> => {
    const url = normalizeUrl(target);
    if (!url) {
      status.textContent = '请输入有效网址';
      return;
    }
    try {
      const info = await request<BrowserSessionInfo>('POST', '/browser/sessions', {
        url,
        width: config?.settings.browser.viewportWidth,
        height: config?.settings.browser.viewportHeight,
      });
      sessionId = info.id;
      frameWidth = info.width;
      frameHeight = info.height;
      status.textContent = `会话 ${info.id}`;
      void poll();
    } catch (error) {
      status.textContent = `启动失败：${messageOf(error)}`;
    }
  };

  const navigate = async (): Promise<void> => {
    const target = normalizeUrl(urlInput.value);
    if (!target) {
      status.textContent = '请输入有效网址';
      return;
    }
    if (!sessionId) {
      await start(target);
      return;
    }
    try {
      await request('POST', `/browser/sessions/${encodeURIComponent(sessionId)}/navigate`, {
        url: target,
      });
    } catch (error) {
      notify(`导航失败：${messageOf(error)}`, 'error');
    }
  };

  const toolbar = h('div', { class: 'pane-toolbar' }, [
    urlInput,
    button('打开', () => void navigate(), { variant: 'primary' }),
    button('刷新', () => void navigate()),
    status,
  ]);
  el.append(toolbar, h('div', { class: 'pane-body browser-body' }, [viewport]));
  void start(String(tab.payload.url ?? ''));
  return {
    el,
    cleanup: () => {
      destroyed = true;
      if (timer !== null) window.clearTimeout(timer);
      if (sessionId) {
        void request('DELETE', `/browser/sessions/${encodeURIComponent(sessionId)}`).catch(
          () => undefined,
        );
      }
    },
  };
};

const createLogPaneFor = (tab: WorkspaceTab): PaneRecord => {
  const el = h('div', { class: 'pane log-pane' });
  const body = h('div', { class: 'pane-body log-body' });
  el.append(body);
  let handle: LogPaneHandle | null = null;

  const mount = (sources: LogSourceInfo[]): void => {
    handle?.destroy();
    clear(body);
    handle = createLogPane(
      body,
      {
        sources,
        sourceId: typeof tab.payload.sourceId === 'string' ? tab.payload.sourceId : null,
        subscriptionId:
          typeof tab.payload.subscriptionId === 'string' ? tab.payload.subscriptionId : null,
      },
      {
        create: (sourceId) =>
          request<LogSubscriptionInfo>('POST', '/logs/subscriptions', { sourceId }),
        poll: (id, since) =>
          request<LogOutput>(
            'GET',
            `/logs/subscriptions/${encodeURIComponent(id)}/output?since=${since}`,
          ),
        stop: (id) => request('DELETE', `/logs/subscriptions/${encodeURIComponent(id)}`),
        compose: (text) => {
          void host
            .compose({ text, mode: 'append' })
            .then(() => notify('日志已追加到 AI 输入框', 'ok'))
            .catch((error: unknown) => notify(`追加失败：${messageOf(error)}`, 'error'));
        },
        persist: (patch) => tabs?.updatePayload(tab.id, patch as Record<string, JsonValue>),
      },
    );
  };

  if (logSources.length) {
    mount(logSources);
  } else {
    body.append(h('p', { class: 'loading', text: '加载日志源…' }));
    void request<LogSourceInfo[]>('GET', '/logs/sources')
      .then((sources) => {
        logSources = sources;
        mount(sources);
      })
      .catch((error) => {
        body.replaceChildren(errorText(messageOf(error)));
      });
  }
  return { el, cleanup: () => handle?.destroy() };
};

const createTerminalPane = (tab: WorkspaceTab): PaneRecord => {
  const el = h('div', { class: 'pane terminal-pane' });
  const output = h('pre', { class: 'terminal-output' });
  const input = h('input', {
    class: 'input terminal-input',
    attrs: { type: 'text', placeholder: '输入命令，Enter 运行', spellcheck: 'false' },
  });
  const shells: TerminalShell[] = ['powershell', 'cmd', 'wsl', 'bash'];
  const current = (typeof tab.payload.shell === 'string'
    ? tab.payload.shell
    : config?.settings.terminalShell ?? 'powershell') as TerminalShell;
  const select = h(
    'select',
    { class: 'input compact' },
    shells.map((value) =>
      h('option', { text: value, attrs: { value, selected: value === current } }),
    ),
  );
  const history: string[] = [];
  let historyIndex = -1;

  const append = (text: string): void => {
    output.append(document.createTextNode(text));
    output.scrollTop = output.scrollHeight;
  };

  const run = async (): Promise<void> => {
    const command = input.value.trim();
    if (!command) return;
    input.value = '';
    history.push(command);
    historyIndex = history.length;
    append(`$ ${command}\n`);
    try {
      const result = await request<TerminalExecResult>('POST', '/terminal/exec', {
        command,
        shell: select.value as TerminalShell,
        cwd: ready?.directory,
        timeoutMs: config?.settings.terminalTimeoutMs,
      });
      if (result.stdout) append(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
      if (result.stderr) append(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
      append(
        `[exit ${result.exitCode ?? '?'}${result.timedOut ? ' timeout' : ''}] ${result.durationMs}ms\n`,
      );
    } catch (error) {
      append(`错误：${messageOf(error)}\n`);
    }
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void run();
      return;
    }
    if (event.key === 'ArrowUp' && history.length) {
      event.preventDefault();
      historyIndex = Math.max(0, historyIndex - 1);
      input.value = history[historyIndex] ?? '';
    }
    if (event.key === 'ArrowDown' && history.length) {
      event.preventDefault();
      historyIndex = Math.min(history.length, historyIndex + 1);
      input.value = history[historyIndex] ?? '';
    }
  });

  const toolbar = h('div', { class: 'pane-toolbar' }, [
    select,
    h('span', { class: 'pane-status', text: ready?.directory ?? '' }),
    h('span', { class: 'spacer' }),
    button('清空', () => clear(output)),
  ]);
  el.append(toolbar, output, h('div', { class: 'terminal-input-row' }, [input]));
  input.focus();
  return { el };
};

const createPane = (tab: WorkspaceTab): PaneRecord => {
  switch (tab.kind) {
    case 'matrix-home': {
      const el = h('div', { class: 'pane home-pane' });
      mountHome(el, homeState, homeActions);
      return { el };
    }
    case 'guest-extension':
      return createGuestPane(tab);
    case 'web-iframe':
      return createWebPane(tab);
    case 'log-stream':
      return createLogPaneFor(tab);
    default:
      return createTerminalPane(tab);
  }
};

const destroyPane = (id: string): void => {
  const record = panes.get(id);
  if (!record) return;
  record.cleanup?.();
  record.el.remove();
  panes.delete(id);
};

const ensurePane = (tab: WorkspaceTab): PaneRecord => {
  const existing = panes.get(tab.id);
  if (existing) return existing;
  const record = createPane(tab);
  panes.set(tab.id, record);
  shell?.body.append(record.el);
  return record;
};

const renderHome = (): void => {
  const record = panes.get('home');
  if (record) mountHome(record.el, homeState, homeActions);
};

const refreshSnapshot = async (showLoading: boolean): Promise<void> => {
  if (refreshing) return;
  refreshing = true;
  if (showLoading) {
    homeState = { ...homeState, loading: true, error: null };
    renderHome();
  }
  try {
    snapshot = await request<MatrixSnapshot>('GET', '/snapshot');
    homeState = {
      snapshot,
      loading: false,
      error: null,
      directory: ready?.directory ?? null,
    };
  } catch (error) {
    homeState = { ...homeState, loading: false, error: messageOf(error) };
  } finally {
    refreshing = false;
    renderHome();
    renderStatus();
  }
};

const renderStatus = (): void => {
  if (!shell) return;
  clear(shell.status);
  shell.status.append(
    h('span', { class: 'status-item', text: `v${snapshot?.health.version ?? '2.0.0'}` }),
    snapshot?.errors.length
      ? h('span', { class: 'status-item error', text: `${snapshot.errors.length} 个资源错误` })
      : h('span', { class: 'status-item ok', text: '服务正常' }),
  );
};

const renderTabs = (): void => {
  if (!shell || !tabs) return;
  const state = tabs.getState();
  clear(shell.strip);
  for (const tab of state.tabs) {
    const el = h('div', {
      class: `tab${tab.id === state.activeId ? ' active' : ''}${tab.pinned ? ' pinned' : ''}`,
      attrs: { draggable: 'true', 'data-id': tab.id, title: tab.title },
    });
    el.append(
      h('span', { class: 'tab-icon', text: tabGlyph(tab) }),
      h('span', { class: 'tab-title', text: tab.title }),
    );
    if (tab.pinned) el.append(h('span', { class: 'tab-pin', text: '•' }));
    if (tab.kind !== 'matrix-home') {
      el.append(
        h('button', {
          class: 'tab-close',
          text: '×',
          attrs: { type: 'button', title: '关闭标签' },
          on: {
            click: (event) => {
              event.stopPropagation();
              closeTab(tab.id);
            },
          },
        }),
      );
    }
    el.addEventListener('click', () => tabs?.activate(tab.id));
    el.addEventListener('auxclick', (event) => {
      if (event.button === 1) closeTab(tab.id);
    });
    el.addEventListener('dblclick', () => tabs?.togglePin(tab.id));
    el.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/plain', tab.id);
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (event) => {
      event.preventDefault();
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (event) => {
      event.preventDefault();
      el.classList.remove('drop-target');
      const dragged = event.dataTransfer?.getData('text/plain');
      if (!dragged || dragged === tab.id) return;
      const rect = el.getBoundingClientRect();
      const index =
        state.tabs.findIndex((item) => item.id === tab.id) +
        (event.clientX > rect.left + rect.width / 2 ? 1 : 0);
      tabs?.move(dragged, index);
    });
    shell.strip.append(el);
  }
};

const renderSplitControls = (): void => {
  if (!shell || !tabs) return;
  const state = tabs.getState();
  shell.splitControls.hidden = !state.split.enabled;
  shell.splitButton.classList.toggle('active', state.split.enabled);
  shell.splitButton.setAttribute('aria-pressed', String(state.split.enabled));
  clear(shell.splitControls);
  if (!state.split.enabled) return;
  const secondary = state.split.secondaryTabId;
  const select = h(
    'select',
    {
      class: 'input compact split-select',
      on: {
        change: (event) =>
          tabs?.setSplit({ secondaryTabId: (event.target as HTMLSelectElement).value }),
      },
    },
    state.tabs
      .filter((tab) => tab.id !== state.activeId)
      .map((tab) =>
        h('option', {
          text: tab.title,
          attrs: { value: tab.id, selected: tab.id === secondary },
        }),
      ),
  );
  shell.splitControls.append(
    h('span', { class: 'split-label', text: '副标签' }),
    select,
    button(
      state.split.direction === 'horizontal' ? '左右' : '上下',
      () =>
        tabs?.setSplit({
          direction: state.split.direction === 'horizontal' ? 'vertical' : 'horizontal',
        }),
      { class: 'small', title: '切换分屏方向' },
    ),
    button('取消', () => tabs?.setSplit({ enabled: false }), {
      class: 'small',
      title: '取消分屏',
    }),
  );
};

const applySplitRatio = (ratio: number): void => {
  if (!tabs) return;
  const active = tabs.activeTab();
  const secondary = tabs.secondaryTab();
  if (!active || !secondary) return;
  const clamped = Math.max(0.2, Math.min(0.8, ratio));
  const first = panes.get(active.id);
  const second = panes.get(secondary.id);
  if (first) first.el.style.flexGrow = String(clamped);
  if (second) second.el.style.flexGrow = String(1 - clamped);
};

const attachSplitDrag = (divider: HTMLElement, body: HTMLElement): void => {
  const ratioAt = (event: PointerEvent): number => {
    const rect = body.getBoundingClientRect();
    if (!tabs) return 0.5;
    const horizontal = tabs.getState().split.direction === 'horizontal';
    const value = horizontal
      ? (event.clientX - rect.left) / Math.max(1, rect.width)
      : (event.clientY - rect.top) / Math.max(1, rect.height);
    return Math.max(0.2, Math.min(0.8, value));
  };

  divider.addEventListener('pointerdown', (event) => {
    if (!tabs || !tabs.getState().split.enabled) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    divider.classList.add('dragging');
    let latest = ratioAt(event);
    const move = (moveEvent: PointerEvent): void => {
      latest = ratioAt(moveEvent);
      applySplitRatio(latest);
    };
    const up = (): void => {
      divider.classList.remove('dragging');
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
      divider.removeEventListener('pointercancel', up);
      tabs?.setSplit({ ratio: latest });
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
    divider.addEventListener('pointercancel', up);
  });

  divider.addEventListener('dblclick', () => tabs?.setSplit({ ratio: 0.5 }));
};

const layoutPanes = (): void => {
  if (!shell || !tabs) return;
  const state = tabs.getState();
  const active = tabs.activeTab();
  const secondary = tabs.secondaryTab();
  const alive = new Set(state.tabs.map((tab) => tab.id));
  for (const id of [...panes.keys()]) if (!alive.has(id)) destroyPane(id);
  for (const tab of state.tabs) ensurePane(tab);
  for (const [id, record] of panes) {
    const visible = id === active?.id || id === secondary?.id;
    record.el.hidden = !visible;
    record.el.style.flexGrow = '1';
    record.el.style.order = id === active?.id ? '0' : id === secondary?.id ? '2' : '1';
  }
  shell.divider.hidden = !secondary;
  if (active) {
    const record = panes.get(active.id);
    if (record) record.el.style.flexGrow = secondary ? String(state.split.ratio) : '1';
  }
  if (secondary) {
    const record = panes.get(secondary.id);
    if (record) record.el.style.flexGrow = String(1 - state.split.ratio);
  }
  shell.root.classList.toggle('split-on', Boolean(secondary));
  shell.body.classList.toggle(
    'split-horizontal',
    Boolean(secondary) && state.split.direction === 'horizontal',
  );
  shell.body.classList.toggle(
    'split-vertical',
    Boolean(secondary) && state.split.direction === 'vertical',
  );
};

const render = (): void => {
  renderTabs();
  layoutPanes();
  renderSplitControls();
  renderStatus();
};

const closeTab = (id: string): void => {
  if (tabs?.close(id)) destroyPane(id);
};

let menuAnchor: HTMLElement | null = null;
let menuCleanup: (() => void) | null = null;

const closeMenu = (): void => {
  menuCleanup?.();
  menuCleanup = null;
  menuAnchor = null;
  tabMenu?.remove();
  tabMenu = null;
};

const openHomeManageMenu = (anchor: HTMLElement): void => {
  if (!shell) return;
  if (tabMenu && menuAnchor === anchor) {
    closeMenu();
    return;
  }
  if (tabMenu) closeMenu();
  const menu = h('div', { class: 'tab-menu home-manage-menu' });
  const item = (label: string, run: () => void): HTMLButtonElement =>
    button(label, () => {
      closeMenu();
      run();
    });
  menu.append(
    h('div', { class: 'menu-label', text: '主页管理' }),
    h('div', { class: 'menu-actions' }, [
      item('主页标签', () => openHomeTabsEditor()),
      item('默认资源', () => openResources('guests')),
      item('自定义分组', () => openHomeGroupsEditor()),
    ]),
  );
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.right - 220, window.innerWidth - 228))}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  tabMenu = menu;
  menuAnchor = anchor;
  const onDocumentClick = (event: MouseEvent): void => {
    if (tabMenu && !tabMenu.contains(event.target as Node) && event.target !== anchor) {
      closeMenu();
    }
  };
  menuCleanup = () => document.removeEventListener('click', onDocumentClick);
  window.setTimeout(() => {
    if (tabMenu === menu) document.addEventListener('click', onDocumentClick);
  }, 0);
};

const toggleNewMenu = (): void => {
  if (!shell) return;
  const anchor = shell.newButton;
  if (tabMenu && menuAnchor === anchor) {
    closeMenu();
    return;
  }
  if (tabMenu) closeMenu();
  const menu = h('div', { class: 'tab-menu' });
  const urlInput = h('input', {
    class: 'input',
    attrs: { type: 'url', placeholder: 'https://…', spellcheck: 'false' },
  });
  menu.append(
    h('div', { class: 'menu-row' }, [
      urlInput,
      button(
        '打开',
        () => {
          const value = urlInput.value.trim();
          if (!value) return;
          openWeb(value, value);
          closeMenu();
        },
        { variant: 'primary' },
      ),
    ]),
    h('div', { class: 'menu-actions' }, [
      button('日志流', () => {
        openLogs();
        closeMenu();
      }),
      button('终端', () => {
        openTerminal();
        closeMenu();
      }),
    ]),
  );
  const guests = snapshot?.guests ?? [];
  if (guests.length) {
    menu.append(h('div', { class: 'menu-label', text: 'Guest 扩展' }));
    const list = h('div', { class: 'menu-guests' });
    for (const guest of guests.slice(0, 24)) {
      list.append(
        button(
          guest.name,
          () => {
            openGuest(guest);
            closeMenu();
          },
          { class: 'menu-guest' },
        ),
      );
    }
    menu.append(list);
  }
  document.body.append(menu);
  const rect = shell.newButton.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 340))}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  tabMenu = menu;
  menuAnchor = anchor;
  const onDocumentClick = (event: MouseEvent): void => {
    if (tabMenu && !tabMenu.contains(event.target as Node) && event.target !== anchor) {
      closeMenu();
    }
  };
  menuCleanup = () => document.removeEventListener('click', onDocumentClick);
  window.setTimeout(() => {
    if (tabMenu === menu) document.addEventListener('click', onDocumentClick);
  }, 0);
};

const refreshAfterSave = async (): Promise<void> => {
  try {
    await refreshSnapshot(false);
  } catch (error) {
    notify(`已保存，但刷新失败：${messageOf(error)}`, 'error');
  }
};

const openConfig = (): void => {
  if (!config) return;
  openConfigModal({
    config,
    path: configPath,
    onSave: async (patch) => {
      config = await request<MatrixConfig>('PUT', '/config', patch);
      notify('配置已保存', 'ok');
      await refreshAfterSave();
      void request<LogSourceInfo[]>('GET', '/logs/sources')
        .then((sources) => {
          logSources = sources;
        })
        .catch(() => undefined);
    },
    onReset: async () => {
      config = await request<MatrixConfig>('POST', '/config/reset');
      notify('已恢复默认配置', 'ok');
      await refreshAfterSave();
    },
    onClose: () => undefined,
  });
};

const openHomeGroupsEditor = (): void => {
  if (!config || !snapshot) {
    notify('矩阵快照尚未加载', 'error');
    return;
  }
  openHomeGroups({
    groups: config.home?.groups ?? [],
    guests: snapshot.guests,
    apps: snapshot.apps,
    bookmarks: config.groups.cloud.bookmarks,
    onSave: async (groups) => {
      config = await request<MatrixConfig>('PUT', '/config', { home: { groups } });
      notify('主页分组已保存', 'ok');
      await refreshAfterSave();
    },
    onClose: () => undefined,
  });
};

const saveHomeSections = async (
  sections: HomeSectionConfig[],
  message: string,
): Promise<void> => {
  config = await request<MatrixConfig>('PUT', '/config', { home: { sections } });
  notify(message, 'ok');
  await refreshAfterSave();
};

const setHomeView = (sectionId: string, view: HomeViewMode): void => {
  const sections = (config?.home.sections ?? []).map((section) =>
    section.id === sectionId ? { ...section, view } : section,
  );
  void saveHomeSections(sections, '视图样式已保存').catch((error) => {
    notify(`保存失败：${messageOf(error)}`, 'error');
  });
};

const moveHomeSection = (sectionId: string, beforeId: string | null): void => {
  const current = config?.home.sections ?? [];
  const from = current.findIndex((section) => section.id === sectionId);
  if (from < 0) return;
  const next = [...current];
  const [moved] = next.splice(from, 1);
  if (!moved) return;
  const target = beforeId ? next.findIndex((section) => section.id === beforeId) : -1;
  next.splice(target < 0 ? next.length : target, 0, moved);
  void saveHomeSections(next, '标签顺序已保存').catch((error) => {
    notify(`保存失败：${messageOf(error)}`, 'error');
  });
};

const openHomeTabsEditor = (): void => {
  if (!config) {
    notify('配置尚未加载', 'error');
    return;
  }
  openHomeTabs({
    sections: config.home.sections ?? [],
    groups: config.home.groups ?? [],
    onSave: async (sections) => {
      await saveHomeSections(sections, '主页标签已保存');
    },
    onClose: () => undefined,
  });
};

const openResources = (section: ResourceSection = 'guests'): void => {
  if (!config || !snapshot) {
    notify('矩阵快照尚未加载', 'error');
    return;
  }
  openResourceEditor({
    config,
    section,
    guests: snapshot.guests,
    apps: snapshot.apps,
    onPickFile: async () => {
      const started = await request<{ token: string }>('POST', '/pick-file/start', {});
      for (let attempt = 0; attempt < 600; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const result = await request<{ pending?: boolean; path?: string | null }>(
          'GET',
          `/pick-file/result?token=${encodeURIComponent(started.token)}`,
        );
        if (!result.pending) return result.path ?? null;
      }
      throw new Error('选择文件超时');
    },
    onSave: async (patch) => {
      config = await request<MatrixConfig>('PUT', '/config', patch);
      notify('资源已保存', 'ok');
      await refreshSnapshot(false);
    },
    onClose: () => undefined,
  });
};

const buildShell = (): Shell => {
  const newButton = button('+ 新标签', () => toggleNewMenu(), { variant: 'primary' });
  const splitButton = button('分屏', () => {
    if (!tabs) return;
    const state = tabs.getState();
    tabs.setSplit({ enabled: !state.split.enabled });
  });
  const splitControls = h('div', {
    class: 'split-controls split-bar',
    attrs: { hidden: 'hidden' },
  });
  splitButton.classList.add('split-toggle');
  splitButton.setAttribute('title', '切换分屏');
  splitButton.setAttribute('aria-pressed', 'false');
  const topbar = h('header', { class: 'topbar' }, [
    h('div', { class: 'brand' }, [
      h('span', { class: 'brand-mark', text: '▦' }),
      h('span', { class: 'brand-name', text: 'OpenWith Matrix' }),
      badge('2.0.0', 'info'),
    ]),
    h('div', { class: 'topbar-actions' }, [
      splitButton,
      button('↻', () => void refreshSnapshot(true), { class: 'icon-button', title: '刷新' }),
      button('⚙', () => openConfig(), { class: 'icon-button', title: '配置' }),
      newButton,
    ]),
  ]);
  const divider = h('div', {
    class: 'split-divider',
    attrs: { hidden: 'hidden', title: '拖动调整比例，双击重置' },
  });
  const strip = h('nav', { class: 'tabstrip' });
  const body = h('main', { class: 'workspace-body' }, [divider]);
  const status = h('footer', { class: 'statusbar' });
  attachSplitDrag(divider, body);
  const root = h('div', { class: 'app' }, [topbar, splitControls, strip, body, status]);
  return { root, strip, body, status, splitControls, splitButton, divider, newButton };
};

const boot = async (): Promise<void> => {
  const mount = document.getElementById('root');
  if (!mount) throw new Error('missing #root');
  ready = await new Promise<HostReadyContext>((resolve) => {
    let off = (): void => undefined;
    off = host.onReady((context) => {
      off();
      resolve(context);
    });
  });
  applyHostReady(ready, document.documentElement);
  shell = buildShell();
  mount.append(shell.root);

  const answer = await service('GET', '/config');
  config = answer.data as MatrixConfig;
  configPath = String(answer.path ?? '');
  homeState = { ...homeState, directory: ready.directory ?? null };

  tabs = new TabManager(
    host.storage,
    Math.max(1, Number(config.settings.maxTabs) || 12),
    (tab) => destroyPane(tab.id),
  );
  tabs.subscribe(() => render());
  await tabs.load();
  render();
  await refreshSnapshot(true);
  try {
    logSources = await request<LogSourceInfo[]>('GET', '/logs/sources');
  } catch {
    logSources = [];
  }
  window.setInterval(() => {
    if (!document.hidden) void refreshSnapshot(false);
  }, 30_000);
};

void boot().catch((error: unknown) => {
  const mount = document.getElementById('root');
  if (mount) mount.append(errorText(`启动失败：${messageOf(error)}`));
});
