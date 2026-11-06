/**
 * Matrix home view: one configurable resource tab at a time.
 *
 * Tabs are stored in `home.sections`, so labels, order, visibility and the
 * per-tab view mode survive restarts. The view is otherwise stateless apart
 * from small form/filter/page values kept at module scope, so a snapshot
 * refresh can rebuild the whole tree without losing the user's K8s forward
 * draft, guest search or current page.
 */

import type {
  AppSummary,
  CloudBookmark,
  DockerContainer,
  GuestSummary,
  HomeGroup,
  HomeItem,
  HomeSectionConfig,
  HomeViewMode,
  MatrixSnapshot,
  ShardxInstance,
} from '../../shared/types.ts';
import type { Child } from '../dom.ts';
import { badge, button, clear, empty, errorText, h, tooltip } from '../dom.ts';
import type { ResourceSection } from './resourceEditorView.ts';

export interface HomeActions {
  rerender(): void;
  openManageMenu(anchor: HTMLElement): void;
  editGroups(): void;
  editTabs(): void;
  editResources(section: ResourceSection): void;
  setHomeView(sectionId: string, view: HomeViewMode): void;
  moveHomeSection(sectionId: string, beforeId: string | null): void;
  openGuest(guest: GuestSummary): void;
  toggleGuest(guest: GuestSummary, enabled: boolean): void;
  openApp(app: AppSummary): void;
  openWeb(url: string, title: string): void;
  openBookmark(bookmark: CloudBookmark): void;
  runWebhook(id: string, name: string): void;
  shardxLaunch(): void;
  shardxStart(instance: ShardxInstance): void;
  shardxStop(instance: ShardxInstance): void;
  dockerAction(container: DockerContainer, action: 'start' | 'stop' | 'restart'): void;
  dockerCompose(action: 'up' | 'down' | 'ps' | 'restart'): void;
  k8sForward(input: {
    context: string;
    namespace: string;
    pod: string;
    localPort: number;
    remotePort: number;
  }): void;
  k8sStopForward(id: string): void;
}

export interface HomeState {
  snapshot: MatrixSnapshot | null;
  loading: boolean;
  error: string | null;
  directory: string | null;
}

interface SectionRender {
  subtitle: string;
  count: number;
  toolbar: Child[];
  body: Child[];
}

const forwardForm = {
  context: '',
  namespace: 'default',
  pod: '',
  localPort: '18080',
  remotePort: '80',
};

const pages = new Map<string, number>();
let guestQuery = '';
let focusGuestSearch = false;
let activeSectionId: string | null = null;
let resetScroll = false;

const initial = (name: string): string => name.trim().slice(0, 1).toUpperCase() || '?';

const stateTone = (state: string): 'ok' | 'warn' | 'error' | 'muted' => {
  const value = state.toLowerCase();
  if (value === 'running' || value === 'open' || value === 'ready') return 'ok';
  if (value === 'exited' || value === 'stopped' || value === 'paused') return 'warn';
  if (value === 'dead' || value === 'error') return 'error';
  return 'muted';
};

const pageSizeOf = (snap: MatrixSnapshot): number => {
  const value = Math.floor(Number(snap.config.home?.pageSize ?? 8));
  return Number.isFinite(value) && value >= 3 ? Math.min(value, 50) : 8;
};

const pageOf = (key: string): number => pages.get(key) ?? 0;

const slicePage = <T>(items: T[], key: string, pageSize: number): T[] => {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(pageOf(key), pageCount - 1);
  return items.slice(page * pageSize, (page + 1) * pageSize);
};

const pager = (
  key: string,
  total: number,
  pageSize: number,
  actions: HomeActions,
): HTMLElement | null => {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;
  const page = Math.min(pageOf(key), pageCount - 1);
  return h('div', { class: 'pager' }, [
    button(
      '‹',
      () => {
        pages.set(key, Math.max(0, page - 1));
        actions.rerender();
      },
      { class: 'small', disabled: page <= 0, title: '上一页' },
    ),
    h('span', { class: 'page-info', text: `${page + 1} / ${pageCount} · ${total} 项` }),
    button(
      '›',
      () => {
        pages.set(key, Math.min(pageCount - 1, page + 1));
        actions.rerender();
      },
      { class: 'small', disabled: page >= pageCount - 1, title: '下一页' },
    ),
  ]);
};

const attachTip = (
  element: HTMLElement,
  title: string,
  rows: Array<[string, string | undefined | null]>,
): void => {
  tooltip(element, () => [
    h('div', { class: 'tip-title', text: title }),
    ...rows
      .filter(([, value]) => Boolean(value))
      .map(([label, value]) =>
        h('div', { class: 'tip-row' }, [
          h('span', { class: 'tip-key', text: label }),
          h('span', { class: 'tip-value', text: String(value) }),
        ]),
      ),
  ]);
};

const renderGuests = (snap: MatrixSnapshot, actions: HomeActions): SectionRender => {
  const pageSize = pageSizeOf(snap);
  const hidden = new Set(snap.config.groups.guests.hidden);
  const order = new Map(snap.config.groups.guests.order.map((id, index) => [id, index]));
  const all = snap.guests
    .filter((guest) => !hidden.has(guest.id))
    .sort(
      (a, b) =>
        (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name),
    );
  const needle = guestQuery.trim().toLowerCase();
  const filtered = needle
    ? all.filter((guest) =>
        `${guest.name} ${guest.id} ${guest.source ?? ''}`.toLowerCase().includes(needle),
      )
    : all;

  const rows = slicePage(filtered, 'guests', pageSize).map((guest) => {
    const openButton = button('打开', () => actions.openGuest(guest), {
      variant: 'primary',
      disabled: !guest.enabled,
    });
    openButton.addEventListener('click', (event) => event.stopPropagation());
    const toggle = h(
      'label',
      {
        class: 'switch',
        attrs: { title: guest.enabled ? `停用 ${guest.name}` : `启用 ${guest.name}` },
        on: { click: (event) => event.stopPropagation() },
      },
      [
        h('input', {
          attrs: { type: 'checkbox', checked: guest.enabled, 'aria-label': `启用 ${guest.name}` },
          on: {
            click: (event) => event.stopPropagation(),
            change: (event) =>
              actions.toggleGuest(guest, (event.target as HTMLInputElement).checked),
          },
        }),
        h('span'),
      ],
    );
    const row = h(
      'div',
      {
        class: `guest-row clickable${guest.enabled ? '' : ' disabled'}`,
        attrs: { title: guest.enabled ? `打开 ${guest.name}` : `${guest.name} 未启用` },
        on: {
          click: () => {
            if (guest.enabled) actions.openGuest(guest);
          },
        },
      },
      [
        h('span', { class: 'avatar', text: initial(guest.name) }),
        h('div', { class: 'guest-meta' }, [
          h('span', { class: 'guest-name', text: guest.name }),
          h('span', {
            class: 'guest-detail',
            text: [guest.id, guest.version ? `v${guest.version}` : '', guest.source ?? '']
              .filter(Boolean)
              .join(' · '),
          }),
        ]),
        guest.capabilities?.granted?.includes('service') ? badge('service', 'info') : null,
        toggle,
        openButton,
      ],
    );
    attachTip(row, guest.name, [
      ['ID', guest.id],
      ['版本', guest.version ? `v${guest.version}` : ''],
      ['来源', guest.source],
      ['路径', guest.path],
      ['状态', guest.enabled ? '已启用' : '已禁用'],
      ['能力', guest.capabilities?.granted?.join(', ')],
    ]);
    return row;
  });

  const search = h('input', {
    class: 'input search guest-search',
    attrs: { type: 'search', placeholder: '筛选扩展…', value: guestQuery },
    on: {
      input: (event) => {
        guestQuery = (event.target as HTMLInputElement).value;
        pages.set('guests', 0);
        focusGuestSearch = true;
        actions.rerender();
      },
    },
  });

  return {
    subtitle: `${all.length} 个已安装 guest${needle ? ` · 匹配 ${filtered.length}` : ''}`,
    count: all.length,
    toolbar: [button('编辑', () => actions.editResources('guests'))],
    body: [
      search,
      rows.length
        ? h('div', { class: 'guest-list' }, rows)
        : empty(needle ? '没有匹配的扩展' : '没有已安装的扩展'),
      pager('guests', filtered.length, pageSize, actions),
    ],
  };
};

const renderWin11Apps = (snap: MatrixSnapshot, actions: HomeActions): SectionRender => {
  const installed = snap.apps.filter((app) => app.installed).length;
  const tiles = snap.apps.map((app) => {
    const tile = h(
      'button',
      {
        class: `app-tile${app.installed ? '' : ' disabled'}`,
        attrs: { type: 'button', disabled: !app.installed },
        on: { click: () => actions.openApp(app) },
      },
      [
        h('span', { class: 'avatar', text: initial(app.name) }),
        h('div', { class: 'app-tile-meta' }, [
          h('span', { class: 'app-name', text: app.name }),
          h('span', { class: 'app-hint', text: app.installed ? app.command : '未安装' }),
        ]),
      ],
    );
    attachTip(tile, app.name, [
      ['命令', app.command],
      ['状态', app.installed ? '已安装' : '未安装'],
    ]);
    return tile;
  });

  return {
    subtitle: `${installed}/${snap.apps.length} 个应用可用`,
    count: snap.apps.length,
    toolbar: [button('编辑应用', () => actions.editResources('win11-apps'))],
    body: [tiles.length ? h('div', { class: 'app-grid' }, tiles) : empty('没有配置应用')],
  };
};

const renderShardx = (snap: MatrixSnapshot, actions: HomeActions): SectionRender => {
  const pageSize = pageSizeOf(snap);
  const shardx = snap.shardx;
  const instances = slicePage(shardx.instances, 'shardx', pageSize).map((instance) => {
    const running = instance.running;
    const row = h('div', { class: `shardx-row${running ? ' running' : ''}` }, [
      h('span', { class: 'shardx-index', text: String(instance.index).padStart(2, '0') }),
      h('div', { class: 'shardx-meta' }, [
        h('span', { class: 'shardx-name', text: instance.name }),
        h('span', {
          class: 'shardx-detail',
          text: [instance.profileId ?? instance.id, instance.folder ?? ''].filter(Boolean).join(' · '),
        }),
      ]),
      badge(running ? '运行中' : '未启动', running ? 'ok' : 'muted'),
      running
        ? button('停止', () => actions.shardxStop(instance), { variant: 'danger' })
        : button('启动', () => actions.shardxStart(instance), { variant: 'primary' }),
    ]);
    attachTip(row, instance.name, [
      ['Profile', instance.profileId ?? ''],
      ['目录', instance.folder],
      ['CDP', instance.cdpUrl],
      ['状态', running ? '运行中' : '未启动'],
    ]);
    return row;
  });

  return {
    subtitle: `ShardX ${shardx.online ? '在线' : '离线'} · ${shardx.running.length}/${shardx.expected} 运行`,
    count: shardx.instances.length,
    toolbar: [
      badge(shardx.online ? 'API 在线' : 'API 离线', shardx.online ? 'ok' : 'warn'),
      button('启动浏览器', actions.shardxLaunch),
      button('编辑', () => actions.editResources('shardx')),
    ],
    body: [
      shardx.error && !shardx.online ? errorText(`ShardX: ${shardx.error}`) : null,
      instances.length
        ? h('div', { class: 'shardx-list' }, instances)
        : empty('配置中没有 ShardX 实例'),
      pager('shardx', shardx.instances.length, pageSize, actions),
    ],
  };
};

const renderWslPorts = (snap: MatrixSnapshot, actions: HomeActions): SectionRender => {
  const wsl = snap.wsl;
  const ports = wsl.ports.map((port) => {
    const openable = port.protocol !== 'tcp';
    const row = h(
      'div',
      {
        class: `port-row${port.open ? ' open' : ''}${openable ? ' clickable' : ''}`,
        attrs: { title: openable ? `打开 ${port.label}` : `${port.protocol} 端口` },
        on: {
          click: () => {
            if (openable) actions.openWeb(port.url ?? `http://127.0.0.1:${port.port}`, port.label);
          },
        },
      },
      [
        h('div', { class: 'port-meta' }, [
          h('span', { class: 'port-label', text: port.label }),
          h('span', { class: 'port-detail', text: `${port.protocol}://127.0.0.1:${port.port}` }),
        ]),
        badge(
          port.open ? `开放${port.latencyMs !== undefined ? ` · ${port.latencyMs}ms` : ''}` : '关闭',
          port.open ? 'ok' : 'muted',
        ),
        button('打开', () => actions.openWeb(port.url ?? `http://127.0.0.1:${port.port}`, port.label), {
          variant: 'primary',
          disabled: !openable,
        }),
      ],
    );
    attachTip(row, port.label, [
      ['协议', port.protocol],
      ['地址', `${port.protocol}://127.0.0.1:${port.port}`],
      ['状态', port.open ? '开放' : '关闭'],
      ['延迟', port.latencyMs !== undefined ? `${port.latencyMs}ms` : ''],
      ['错误', port.error],
    ]);
    return row;
  });

  return {
    subtitle: wsl.available
      ? `${wsl.distros.length} 个发行版${wsl.ip ? ` · IP ${wsl.ip}` : ''}`
      : 'WSL 不可用',
    count: ports.length,
    toolbar: [
      button('编辑发行版', () => actions.editResources('wsl-distros')),
      button('编辑端口', () => actions.editResources('wsl-ports')),
    ],
    body: [
      wsl.distros.length
        ? h(
            'div',
            { class: 'chip-row' },
            wsl.distros.map((distro) =>
              badge(`${distro.name}${distro.default ? ' · 默认' : ''}`, 'info'),
            ),
          )
        : null,
      ports.length ? h('div', { class: 'port-list' }, ports) : empty('没有配置端口'),
      wsl.error ? errorText(`WSL: ${wsl.error}`) : null,
    ],
  };
};

const renderDockerContainers = (snap: MatrixSnapshot, actions: HomeActions): SectionRender => {
  const pageSize = pageSizeOf(snap);
  const docker = snap.docker;
  const rows = slicePage(docker.containers, 'docker', pageSize).map((container) => {
    const running = container.state === 'running';
    const row = h('div', { class: 'container-row' }, [
      h('div', { class: 'container-meta' }, [
        h('span', { class: 'container-name', text: container.name }),
        h('span', { class: 'container-detail', text: `${container.image} · ${container.status}` }),
      ]),
      badge(container.state, stateTone(container.state)),
      running
        ? button('停止', () => actions.dockerAction(container, 'stop'), { variant: 'danger' })
        : button('启动', () => actions.dockerAction(container, 'start'), { variant: 'primary' }),
      button('重启', () => actions.dockerAction(container, 'restart')),
    ]);
    attachTip(row, container.name, [
      ['镜像', container.image],
      ['状态', container.status],
      ['端口', container.ports],
      ['ID', container.id],
    ]);
    return row;
  });

  return {
    subtitle: docker.available ? `${docker.containers.length} 个容器` : 'Docker 不可用',
    count: docker.containers.length,
    toolbar: [
      button('编辑 Compose', () => actions.editResources('docker-compose')),
      button('编辑容器', () => actions.editResources('docker-containers')),
    ],
    body: [
      h('div', { class: 'button-row' }, [
        button('Compose 启动', () => actions.dockerCompose('up'), { variant: 'primary' }),
        button('Compose 停止', () => actions.dockerCompose('down')),
        button('Compose 状态', () => actions.dockerCompose('ps')),
        button('Compose 重启', () => actions.dockerCompose('restart')),
      ]),
      rows.length ? h('div', { class: 'container-list' }, rows) : empty('没有运行中的容器'),
      pager('docker', docker.containers.length, pageSize, actions),
      docker.error ? errorText(`Docker: ${docker.error}`) : null,
    ],
  };
};

const renderK8sForwards = (snap: MatrixSnapshot, actions: HomeActions): SectionRender => {
  const pageSize = pageSizeOf(snap);
  const k8s = snap.k8s;
  const settings = snap.config.settings.k8s;
  const contexts = k8s.contexts.length
    ? k8s.contexts.map((context) => context.name)
    : snap.config.groups.k8s.contexts.map((context) => context.name);
  if (!forwardForm.context) {
    forwardForm.context = settings.defaultContext || contexts[0] || '';
  }

  const contextSelect = h(
    'select',
    {
      class: 'input',
      on: {
        change: (event) => {
          forwardForm.context = (event.target as HTMLSelectElement).value;
        },
      },
    },
    contexts.map((name) =>
      h('option', { text: name, attrs: { value: name, selected: name === forwardForm.context } }),
    ),
  );

  const podsForContext = k8s.pods.filter(
    (pod) => !forwardForm.context || pod.context === forwardForm.context,
  );
  const podList = h('datalist', { attrs: { id: 'k8s-pods' } }, [
    ...podsForContext.map((pod) =>
      h('option', { attrs: { value: pod.name, label: `${pod.namespace}/${pod.name}` } }),
    ),
  ]);

  const podInput = h('input', {
    class: 'input',
    attrs: { type: 'text', list: 'k8s-pods', placeholder: 'pod 名称', value: forwardForm.pod },
    on: {
      input: (event) => {
        forwardForm.pod = (event.target as HTMLInputElement).value;
      },
    },
  });
  const namespaceInput = h('input', {
    class: 'input',
    attrs: { type: 'text', placeholder: 'namespace', value: forwardForm.namespace },
    on: {
      input: (event) => {
        forwardForm.namespace = (event.target as HTMLInputElement).value;
      },
    },
  });
  const localInput = h('input', {
    class: 'input',
    attrs: { type: 'number', min: 1, max: 65535, value: forwardForm.localPort },
    on: {
      input: (event) => {
        forwardForm.localPort = (event.target as HTMLInputElement).value;
      },
    },
  });
  const remoteInput = h('input', {
    class: 'input',
    attrs: { type: 'number', min: 1, max: 65535, value: forwardForm.remotePort },
    on: {
      input: (event) => {
        forwardForm.remotePort = (event.target as HTMLInputElement).value;
      },
    },
  });

  const submit = (): void => {
    const localPort = Number(forwardForm.localPort);
    const remotePort = Number(forwardForm.remotePort);
    if (!forwardForm.context || !forwardForm.pod || !localPort || !remotePort) return;
    actions.k8sForward({
      context: forwardForm.context,
      namespace: forwardForm.namespace || 'default',
      pod: forwardForm.pod,
      localPort,
      remotePort,
    });
  };

  const forwards = k8s.forwards.map((forward) => {
    const row = h('div', { class: 'forward-row' }, [
      h('div', { class: 'forward-meta' }, [
        h('span', {
          class: 'forward-name',
          text: `${forward.namespace}/${forward.pod}`,
        }),
        h('span', {
          class: 'forward-detail',
          text: `${forward.context} · 127.0.0.1:${forward.localPort} → ${forward.remotePort}`,
        }),
      ]),
      badge(forward.running ? '转发中' : '已停止', forward.running ? 'ok' : 'muted'),
      button('停止', () => actions.k8sStopForward(forward.id), { variant: 'danger' }),
    ]);
    attachTip(row, `${forward.namespace}/${forward.pod}`, [
      ['Context', forward.context],
      ['本地', `127.0.0.1:${forward.localPort}`],
      ['远端', String(forward.remotePort)],
      ['状态', forward.running ? '转发中' : '已停止'],
    ]);
    return row;
  });

  const pods = slicePage(k8s.pods, 'k8s-pods', pageSize).map((pod) => {
    const row = h('div', { class: 'pod-row' }, [
      h('div', { class: 'pod-meta' }, [
        h('span', { class: 'pod-name', text: `${pod.namespace}/${pod.name}` }),
        h('span', {
          class: 'pod-detail',
          text: `${pod.context} · ready ${pod.ready} · restarts ${pod.restarts}`,
        }),
      ]),
      badge(pod.status, pod.status.toLowerCase() === 'running' ? 'ok' : 'warn'),
    ]);
    attachTip(row, `${pod.namespace}/${pod.name}`, [
      ['Context', pod.context],
      ['状态', pod.status],
      ['Ready', pod.ready],
      ['重启', pod.restarts],
      ['Age', pod.age],
    ]);
    return row;
  });

  return {
    subtitle: k8s.available
      ? `${k8s.contexts.length} 个上下文 · ${k8s.forwards.length} 个转发 · ${k8s.pods.length} 个 pod`
      : 'kubectl 不可用',
    count: k8s.forwards.length,
    toolbar: [
      button('编辑 Context', () => actions.editResources('k8s-contexts')),
      button('编辑转发', () => actions.editResources('k8s-forwards')),
    ],
    body: [
      contexts.length
        ? h(
            'div',
            { class: 'chip-row' },
            k8s.contexts.map((context) =>
              badge(`${context.name}${context.current ? ' · 当前' : ''}`, 'info'),
            ),
          )
        : empty('没有可用的 kube context'),
      h('div', { class: 'form-grid' }, [
        h('label', { class: 'field' }, [h('span', { text: 'Context' }), contextSelect]),
        h('label', { class: 'field' }, [h('span', { text: 'Namespace' }), namespaceInput]),
        h('label', { class: 'field' }, [h('span', { text: 'Pod' }), podInput]),
        h('label', { class: 'field' }, [h('span', { text: '本地端口' }), localInput]),
        h('label', { class: 'field' }, [h('span', { text: '远端端口' }), remoteInput]),
        h('div', { class: 'field field-submit' }, [button('建立转发', submit, { variant: 'primary' })]),
      ]),
      podList,
      forwards.length ? h('div', { class: 'forward-list' }, forwards) : empty('没有活动端口转发'),
      pods.length ? h('div', { class: 'pod-list' }, pods) : null,
      pager('k8s-pods', k8s.pods.length, pageSize, actions),
      k8s.error ? errorText(`Kubernetes: ${k8s.error}`) : null,
    ],
  };
};

const renderCloudBookmarks = (snap: MatrixSnapshot, actions: HomeActions): SectionRender => {
  const pageSize = pageSizeOf(snap);
  const groups = new Map<string, CloudBookmark[]>();
  for (const bookmark of snap.config.groups.cloud.bookmarks) {
    const group = bookmark.group ?? '链接';
    groups.set(group, [...(groups.get(group) ?? []), bookmark]);
  }

  const bookmarkGroups = [...groups.entries()].map(([group, bookmarks]) => {
    const tiles = slicePage(bookmarks, `cloud:${group}`, pageSize).map((bookmark) => {
      const tile = h(
        'button',
        {
          class: 'bookmark-tile',
          attrs: { type: 'button' },
          on: { click: () => actions.openBookmark(bookmark) },
        },
        [
          h('span', { class: 'bookmark-name', text: bookmark.name }),
          h('span', { class: 'bookmark-url', text: bookmark.url }),
          badge(
            bookmark.openIn === 'panel' ? '面板' : bookmark.openIn === 'host' ? '宿主' : '浏览器',
            'muted',
          ),
        ],
      );
      attachTip(tile, bookmark.name, [
        ['地址', bookmark.url],
        ['打开方式', bookmark.openIn],
        ['分组', bookmark.group],
      ]);
      return tile;
    });
    return h('div', { class: 'bookmark-group' }, [
      h('h3', { text: group }),
      h('div', { class: 'bookmark-grid' }, tiles),
      pager(`cloud:${group}`, bookmarks.length, pageSize, actions),
    ]);
  });

  return {
    subtitle: `${snap.config.groups.cloud.bookmarks.length} 个书签`,
    count: snap.config.groups.cloud.bookmarks.length,
    toolbar: [button('编辑书签', () => actions.editResources('cloud-bookmarks'))],
    body: bookmarkGroups.length ? bookmarkGroups : [empty('没有配置书签')],
  };
};

const renderCloudWebhooks = (snap: MatrixSnapshot, actions: HomeActions): SectionRender => {
  const webhooks = snap.config.groups.cloud.webhooks.map((webhook) => {
    const row = h('div', { class: 'webhook-row' }, [
      h('div', { class: 'webhook-meta' }, [
        h('span', { class: 'webhook-name', text: webhook.name }),
        h('span', { class: 'webhook-detail', text: `${webhook.method} ${webhook.url}` }),
      ]),
      button('运行', () => actions.runWebhook(webhook.id, webhook.name), { variant: 'primary' }),
    ]);
    attachTip(row, webhook.name, [
      ['方法', webhook.method],
      ['地址', webhook.url],
    ]);
    return row;
  });

  return {
    subtitle: `${snap.config.groups.cloud.webhooks.length} 个 webhook`,
    count: snap.config.groups.cloud.webhooks.length,
    toolbar: [button('编辑 Webhook', () => actions.editResources('cloud-webhooks'))],
    body: [
      webhooks.length ? h('div', { class: 'webhook-list' }, webhooks) : empty('没有配置 webhook'),
    ],
  };
};

interface ResolvedItem {
  label: string;
  detail: string;
  icon: string;
  kindLabel: string;
  target: string;
  disabled: boolean;
  open: () => void;
}

const iconGlyph = (icon: string | undefined, name: string, fallback: string): string => {
  const trimmed = icon?.trim();
  if (trimmed && trimmed.length <= 2 && !/[./\\]/.test(trimmed)) return trimmed;
  return Array.from(name.trim())[0] ?? fallback;
};

const resolveItem = (snap: MatrixSnapshot, item: HomeItem, actions: HomeActions): ResolvedItem => {
  const fallback = item.label ?? item.ref;
  switch (item.kind) {
    case 'guest': {
      const guest = snap.guests.find((entry) => entry.id === item.ref);
      return {
        label: item.label ?? guest?.name ?? item.ref,
        detail: guest ? `扩展 · ${guest.version ? `v${guest.version}` : guest.id}` : '扩展缺失',
        icon: iconGlyph(guest?.icon, guest?.name ?? item.ref, '▣'),
        kindLabel: '扩展',
        target: item.ref,
        disabled: !guest,
        open: () => {
          if (guest) actions.openGuest(guest);
        },
      };
    }
    case 'app': {
      const app = snap.apps.find((entry) => entry.id === item.ref);
      return {
        label: item.label ?? app?.name ?? item.ref,
        detail: app ? `应用 · ${app.command}` : '应用缺失',
        icon: iconGlyph(app?.icon, app?.name ?? item.ref, '▤'),
        kindLabel: '应用',
        target: item.ref,
        disabled: !app?.installed,
        open: () => {
          if (app) actions.openApp(app);
        },
      };
    }
    case 'bookmark': {
      const bookmark = snap.config.groups.cloud.bookmarks.find((entry) => entry.id === item.ref);
      return {
        label: item.label ?? bookmark?.name ?? item.ref,
        detail: bookmark ? `书签 · ${bookmark.url}` : '书签缺失',
        icon: iconGlyph(bookmark?.icon, bookmark?.name ?? item.ref, '◈'),
        kindLabel: '书签',
        target: bookmark?.url ?? item.ref,
        disabled: !bookmark,
        open: () => {
          if (bookmark) actions.openBookmark(bookmark);
        },
      };
    }
    default:
      return {
        label: fallback,
        detail: `链接 · ${item.ref}`,
        icon: iconGlyph(item.icon, fallback, '↗'),
        kindLabel: '链接',
        target: item.ref,
        disabled: !item.ref.trim(),
        open: () => actions.openWeb(item.ref, fallback),
      };
  }
};

const renderCustomGroup = (
  section: HomeSectionConfig,
  snap: MatrixSnapshot,
  actions: HomeActions,
): SectionRender => {
  const group: HomeGroup | undefined = snap.config.home.groups.find(
    (entry) => entry.id === section.groupId,
  );
  if (!group) {
    return {
      subtitle: '分组已删除',
      count: 0,
      toolbar: [button('编辑分组', actions.editGroups)],
      body: [empty('这个分组已不存在')],
    };
  }

  const pageSize = pageSizeOf(snap);
  const items = slicePage(group.items, `home:${group.id}`, pageSize).map((item) => {
    const resolved = resolveItem(snap, item, actions);
    const tile = h(
      'button',
      {
        class: `custom-item${resolved.disabled ? ' disabled' : ''}`,
        attrs: { type: 'button', disabled: resolved.disabled },
        on: { click: resolved.open },
      },
      [
        h('span', { class: 'custom-icon', text: resolved.icon }),
        h('div', { class: 'custom-meta' }, [
          h('span', { class: 'custom-name', text: resolved.label }),
          h('span', { class: 'custom-detail', text: resolved.detail }),
        ]),
        badge(resolved.kindLabel, 'muted'),
      ],
    );
    attachTip(tile, resolved.label, [
      ['类型', resolved.kindLabel],
      ['目标', resolved.target],
      ['状态', resolved.disabled ? '不可用' : '可用'],
    ]);
    return tile;
  });

  return {
    subtitle: `${group.items.length} 项 · 自定义分组`,
    count: group.items.length,
    toolbar: [button('编辑分组', actions.editGroups)],
    body: items.length
      ? [
          h('div', { class: 'custom-grid' }, items),
          pager(`home:${group.id}`, group.items.length, pageSize, actions),
        ]
      : [empty('这个分组还没有项目')],
  };
};

const renderSection = (
  section: HomeSectionConfig,
  snap: MatrixSnapshot,
  actions: HomeActions,
): SectionRender => {
  switch (section.kind) {
    case 'guests':
      return renderGuests(snap, actions);
    case 'win11-apps':
      return renderWin11Apps(snap, actions);
    case 'shardx':
      return renderShardx(snap, actions);
    case 'wsl-ports':
      return renderWslPorts(snap, actions);
    case 'docker-containers':
      return renderDockerContainers(snap, actions);
    case 'k8s-forwards':
      return renderK8sForwards(snap, actions);
    case 'cloud-bookmarks':
      return renderCloudBookmarks(snap, actions);
    case 'cloud-webhooks':
      return renderCloudWebhooks(snap, actions);
    default:
      return renderCustomGroup(section, snap, actions);
  }
};

const sectionCount = (section: HomeSectionConfig, snap: MatrixSnapshot): number => {
  switch (section.kind) {
    case 'guests': {
      const hidden = new Set(snap.config.groups.guests.hidden);
      return snap.guests.filter((guest) => !hidden.has(guest.id)).length;
    }
    case 'win11-apps':
      return snap.apps.length;
    case 'shardx':
      return snap.shardx.instances.length;
    case 'wsl-ports':
      return snap.wsl.ports.length;
    case 'docker-containers':
      return snap.docker.containers.length;
    case 'k8s-forwards':
      return snap.k8s.forwards.length;
    case 'cloud-bookmarks':
      return snap.config.groups.cloud.bookmarks.length;
    case 'cloud-webhooks':
      return snap.config.groups.cloud.webhooks.length;
    default:
      return (
        snap.config.home.groups.find((group) => group.id === section.groupId)?.items.length ?? 0
      );
  }
};

const visibleSections = (snap: MatrixSnapshot): HomeSectionConfig[] => {
  const sections = snap.config.home?.sections ?? [];
  return sections.filter((section) => {
    if (section.removed || !section.visible) return false;
    if (section.kind === 'custom-group') {
      return Boolean(
        section.groupId && snap.config.home.groups.some((group) => group.id === section.groupId),
      );
    }
    return true;
  });
};

const renderTabBar = (
  sections: HomeSectionConfig[],
  activeId: string | null,
  snap: MatrixSnapshot,
  actions: HomeActions,
): HTMLElement => {
  const bar = h('div', {
    class: 'home-tabs',
    attrs: { role: 'tablist', 'aria-label': '主页资源标签' },
  });
  for (const section of sections) {
    const active = section.id === activeId;
    const tab = h(
      'button',
      {
        class: `home-tab${active ? ' active' : ''}`,
        attrs: {
          type: 'button',
          role: 'tab',
          draggable: 'true',
          'aria-selected': active ? 'true' : 'false',
          'data-section-id': section.id,
          title: `${section.label} · 拖拽排序`,
        },
        on: {
          click: () => {
            if (activeSectionId === section.id) return;
            activeSectionId = section.id;
            resetScroll = true;
            actions.rerender();
          },
        },
      },
      [
        h('span', { class: 'home-tab-label', text: section.label }),
        h('span', { class: 'home-tab-count', text: String(sectionCount(section, snap)) }),
      ],
    );
    tab.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/plain', section.id);
      tab.classList.add('dragging');
    });
    tab.addEventListener('dragend', () => tab.classList.remove('dragging'));
    tab.addEventListener('dragover', (event) => {
      event.preventDefault();
      tab.classList.add('drop-target');
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop-target'));
    tab.addEventListener('drop', (event) => {
      event.preventDefault();
      tab.classList.remove('drop-target');
      const dragged = event.dataTransfer?.getData('text/plain');
      if (!dragged || dragged === section.id) return;
      const rect = tab.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      const index = sections.findIndex((entry) => entry.id === section.id);
      const beforeId = after ? sections[index + 1]?.id ?? null : section.id;
      actions.moveHomeSection(dragged, beforeId);
    });
    bar.append(tab);
  }
  bar.append(
    button('＋', actions.editTabs, { class: 'home-tab-add', title: '编辑主页标签' }),
  );
  return bar;
};

const VIEW_MODES: Array<{ mode: HomeViewMode; label: string }> = [
  { mode: 'list', label: '列表' },
  { mode: 'cards', label: '卡片' },
  { mode: 'compact', label: '紧凑' },
];

const renderPanel = (
  section: HomeSectionConfig,
  render: SectionRender,
  actions: HomeActions,
): HTMLElement => {
  const viewSwitch = h(
    'div',
    { class: 'view-switch', attrs: { role: 'group', 'aria-label': '视图样式' } },
    VIEW_MODES.map((view) =>
      h('button', {
        class: view.mode === section.view ? 'active' : '',
        text: view.label,
        attrs: {
          type: 'button',
          title: `切换为${view.label}视图`,
          'aria-pressed': view.mode === section.view ? 'true' : 'false',
        },
        on: { click: () => actions.setHomeView(section.id, view.mode) },
      }),
    ),
  );

  return h('section', { class: 'home-panel', attrs: { 'data-section': section.id } }, [
    h('header', { class: 'home-panel-head' }, [
      h('div', { class: 'home-panel-titles' }, [
        h('h2', { text: section.label }),
        h('p', { class: 'card-subtitle', text: render.subtitle }),
      ]),
      viewSwitch,
      render.toolbar.length ? h('div', { class: 'home-panel-actions' }, render.toolbar) : null,
    ]),
    h('div', { class: `home-panel-body view-${section.view}` }, render.body),
  ]);
};

export function mountHome(container: HTMLElement, state: HomeState, actions: HomeActions): void {
  const scroll = container.scrollTop;
  clear(container);
  const root = h('div', { class: 'home' });
  container.append(root);

  const snap = state.snapshot;
  const sections = snap ? visibleSections(snap) : [];
  const customCount = snap?.config.home.groups.length ?? 0;

  const manageButton = button('管理 ▾', () => actions.openManageMenu(manageButton), {
    class: 'home-manage-button',
    title: '管理主页标签、默认资源与自定义分组',
  });
  root.append(
    h('div', { class: 'home-head' }, [
      h('div', {}, [
        h('h1', { text: '矩阵主页' }),
        h('p', {
          class: 'home-subtitle',
          text: snap
            ? `${sections.length} 个资源标签 · ${customCount} 个自定义分组 · 点击标签切换视图`
            : '正在加载矩阵快照…',
        }),
      ]),
      h('div', { class: 'home-actions' }, [manageButton]),
    ]),
  );

  if (state.error) root.append(errorText(state.error));
  if (snap) {
    if (snap.errors.length) {
      root.append(
        h(
          'div',
          { class: 'notice' },
          snap.errors.map((message) => h('p', { text: message })),
        ),
      );
    }

    if (!sections.length) {
      root.append(
        h('section', { class: 'home-panel' }, [
          h('div', { class: 'home-panel-body' }, [
            h('p', { class: 'empty', text: '所有资源标签都被隐藏了。打开标签编辑器重新显示。' }),
            button('编辑标签', actions.editTabs, { variant: 'primary' }),
          ]),
        ]),
      );
    } else {
      if (!activeSectionId || !sections.some((section) => section.id === activeSectionId)) {
        activeSectionId = sections[0]?.id ?? null;
      }
      const active = sections.find((section) => section.id === activeSectionId) ?? sections[0];
      if (active) {
        root.append(renderTabBar(sections, active.id, snap, actions));
        root.append(renderPanel(active, renderSection(active, snap, actions), actions));
      }
    }
  } else {
    root.append(h('p', { class: 'loading', text: state.loading ? '正在加载矩阵快照…' : '尚无快照' }));
  }

  if (focusGuestSearch) {
    focusGuestSearch = false;
    const input = root.querySelector<HTMLInputElement>('.guest-search');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
  container.scrollTop = resetScroll ? 0 : scroll;
  resetScroll = false;
}
