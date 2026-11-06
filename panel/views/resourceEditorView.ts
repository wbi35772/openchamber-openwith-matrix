/**
 * Default-group resource editor.
 *
 * The six built-in groups (guests, Windows apps/ShardX, WSL, Docker, K8s and
 * cloud) used to be config-file only. This modal edits the same `MatrixGroups`
 * object with structured rows, including adding an arbitrary `.exe` through the
 * service-side Windows file picker.
 */

import type {
  AppSummary,
  GuestSummary,
  MatrixConfig,
  MatrixGroups,
} from '../../shared/types.ts';
import { badge, button, clear, h } from '../dom.ts';

export type ResourceSection =
  | 'guests'
  | 'win11-apps'
  | 'shardx'
  | 'wsl-distros'
  | 'wsl-ports'
  | 'docker-compose'
  | 'docker-containers'
  | 'k8s-contexts'
  | 'k8s-forwards'
  | 'cloud-bookmarks'
  | 'cloud-webhooks';

type AnyRecord = Record<string, any>;

type FieldType = 'text' | 'number' | 'select' | 'checkbox' | 'textarea' | 'args';

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  placeholder?: string;
  hint?: string;
  pick?: 'exe';
}

interface SectionDef {
  id: ResourceSection;
  label: string;
  hint: string;
  addLabel: string;
  fields: FieldDef[];
  items: () => AnyRecord[];
  replace: (items: AnyRecord[]) => void;
  make: () => AnyRecord;
}

export interface ResourceEditorOptions {
  config: MatrixConfig;
  section?: ResourceSection;
  guests: GuestSummary[];
  apps: AppSummary[];
  onSave(patch: { groups: MatrixGroups }): Promise<void>;
  onPickFile(): Promise<string | null>;
  onClose(): void;
}

const NAV: Array<{ label: string; sections: ResourceSection[] }> = [
  { label: '扩展', sections: ['guests'] },
  { label: 'Windows', sections: ['win11-apps', 'shardx'] },
  { label: 'WSL', sections: ['wsl-distros', 'wsl-ports'] },
  { label: 'Docker', sections: ['docker-compose', 'docker-containers'] },
  { label: 'Kubernetes', sections: ['k8s-contexts', 'k8s-forwards'] },
  { label: '云', sections: ['cloud-bookmarks', 'cloud-webhooks'] },
];

let counter = 0;

const uid = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(counter += 1).toString(36)}`;

const basename = (target: string): string => {
  const file = target.split(/[\\/]/).pop() ?? target;
  return file.replace(/\.(exe|cmd|bat|com)$/i, '') || file;
};

const titleOf = (item: AnyRecord, index: number): string =>
  String(item.name ?? item.label ?? item.value ?? item.pod ?? `项目 ${index + 1}`);

export function openResourceEditor(options: ResourceEditorOptions): void {
  const draft = structuredClone(options.config.groups);
  let sectionId: ResourceSection = options.section ?? 'guests';
  let saving = false;

  const error = h('p', { class: 'error-text' });
  const navEl = h('div', { class: 'resource-nav' });
  const panelEl = h('div', { class: 'resource-panel' });

  const sections: Record<ResourceSection, SectionDef> = {
    guests: {
      id: 'guests',
      label: '扩展',
      hint: '选择主页显示的扩展，并调整顺序。停用开关仍在主页卡片上。',
      addLabel: '',
      fields: [],
      items: () => [],
      replace: () => undefined,
      make: () => ({}),
    },
    'win11-apps': {
      id: 'win11-apps',
      label: 'Windows 应用',
      hint: '可以直接填写命令，也可以用“选择 EXE”从系统里挑一个可执行文件。',
      addLabel: '+ 添加应用',
      fields: [
        { key: 'name', label: '名称', type: 'text', placeholder: '例如 Visual Studio Code' },
        {
          key: 'command',
          label: '命令 / 路径',
          type: 'text',
          placeholder: 'code 或 C:\\Tools\\App.exe',
          pick: 'exe',
        },
        { key: 'args', label: '参数', type: 'args', hint: '空格分隔，例如 --new-window' },
        { key: 'icon', label: '图标', type: 'text', placeholder: '可选，单个字符或图标名' },
      ],
      items: () => draft.win11.apps as unknown as AnyRecord[],
      replace: (items) => {
        draft.win11.apps = items as never;
      },
      make: () => ({ id: uid('app'), name: '新应用', command: '', args: [], icon: '' }),
    },
    shardx: {
      id: 'shardx',
      label: 'ShardX 实例',
      hint: '每个实例对应一个 ShardX profile；启动、停止仍在主页卡片上操作。',
      addLabel: '+ 添加实例',
      fields: [
        { key: 'name', label: '名称', type: 'text', placeholder: '例如 工作区 01' },
        { key: 'profileId', label: 'Profile ID', type: 'text', placeholder: '可选' },
        { key: 'folder', label: '数据目录', type: 'text', placeholder: '可选' },
      ],
      items: () => draft.win11.shardx as unknown as AnyRecord[],
      replace: (items) => {
        draft.win11.shardx = items as never;
      },
      make: () => ({ id: uid('shardx'), name: '新实例', profileId: '', folder: '' }),
    },
    'wsl-distros': {
      id: 'wsl-distros',
      label: 'WSL 发行版',
      hint: '这里只影响面板里的快捷入口，不会安装或删除发行版。',
      addLabel: '+ 添加发行版',
      fields: [
        { key: 'name', label: '发行版', type: 'text', placeholder: 'Ubuntu-24.04' },
        { key: 'user', label: '默认用户', type: 'text', placeholder: '可选' },
        { key: 'default', label: '设为默认', type: 'checkbox' },
      ],
      items: () => draft.wsl.distros as unknown as AnyRecord[],
      replace: (items) => {
        draft.wsl.distros = items as never;
      },
      make: () => ({ name: 'Ubuntu-24.04', user: '', default: false }),
    },
    'wsl-ports': {
      id: 'wsl-ports',
      label: 'WSL 端口',
      hint: '端口会显示在主页，点击即可在面板内打开。',
      addLabel: '+ 添加端口',
      fields: [
        { key: 'label', label: '名称', type: 'text', placeholder: '例如 Ollama' },
        { key: 'port', label: '端口', type: 'number', placeholder: '11434' },
        { key: 'protocol', label: '协议', type: 'select', options: ['http', 'https', 'tcp'] },
        { key: 'path', label: '路径', type: 'text', placeholder: '可选，例如 /api' },
      ],
      items: () => draft.wsl.ports as unknown as AnyRecord[],
      replace: (items) => {
        draft.wsl.ports = items as never;
      },
      make: () => ({ id: uid('port'), label: '新端口', port: 8080, protocol: 'http', path: '' }),
    },
    'docker-compose': {
      id: 'docker-compose',
      label: 'Compose 文件',
      hint: '一行一个 compose 文件路径；Compose 按钮会按这里的顺序执行。',
      addLabel: '+ 添加文件',
      fields: [{ key: 'value', label: '文件路径', type: 'text', placeholder: 'D:\\stack\\docker-compose.yml' }],
      items: () => draft.docker.composeFiles.map((value) => ({ value })) as AnyRecord[],
      replace: (items) => {
        draft.docker.composeFiles = items
          .map((item) => String(item.value ?? '').trim())
          .filter(Boolean);
      },
      make: () => ({ value: '' }),
    },
    'docker-containers': {
      id: 'docker-containers',
      label: '容器',
      hint: '一行一个容器名；主页会优先展示这些容器。',
      addLabel: '+ 添加容器',
      fields: [{ key: 'value', label: '容器名', type: 'text', placeholder: 'openchamber' }],
      items: () => draft.docker.containers.map((value) => ({ value })) as AnyRecord[],
      replace: (items) => {
        draft.docker.containers = items
          .map((item) => String(item.value ?? '').trim())
          .filter(Boolean);
      },
      make: () => ({ value: '' }),
    },
    'k8s-contexts': {
      id: 'k8s-contexts',
      label: 'Kube Context',
      hint: '这些 context 会出现在端口转发的下拉框里。',
      addLabel: '+ 添加 context',
      fields: [
        { key: 'name', label: 'Context', type: 'text', placeholder: 'docker-desktop' },
        { key: 'namespace', label: '默认 namespace', type: 'text', placeholder: 'default' },
      ],
      items: () => draft.k8s.contexts as unknown as AnyRecord[],
      replace: (items) => {
        draft.k8s.contexts = items as never;
      },
      make: () => ({ name: '', namespace: 'default' }),
    },
    'k8s-forwards': {
      id: 'k8s-forwards',
      label: '端口转发',
      hint: '预置转发规则；启动和停止仍在主页操作。',
      addLabel: '+ 添加转发',
      fields: [
        { key: 'context', label: 'Context', type: 'text', placeholder: 'docker-desktop' },
        { key: 'namespace', label: 'Namespace', type: 'text', placeholder: 'default' },
        { key: 'pod', label: 'Pod', type: 'text', placeholder: 'pod-name' },
        { key: 'localPort', label: '本地端口', type: 'number', placeholder: '18080' },
        { key: 'remotePort', label: '远端端口', type: 'number', placeholder: '80' },
      ],
      items: () => draft.k8s.portForwards as unknown as AnyRecord[],
      replace: (items) => {
        draft.k8s.portForwards = items as never;
      },
      make: () => ({
        id: uid('forward'),
        context: '',
        namespace: 'default',
        pod: '',
        localPort: 18080,
        remotePort: 80,
      }),
    },
    'cloud-bookmarks': {
      id: 'cloud-bookmarks',
      label: '云书签',
      hint: '链接支持 {path}、{winPath}、{pathUrlEncode}、{projectName}、{gitBranch}、{wslIp}。',
      addLabel: '+ 添加书签',
      fields: [
        { key: 'name', label: '名称', type: 'text', placeholder: '例如 GitHub' },
        { key: 'url', label: '地址', type: 'text', placeholder: 'https://example.com/?path={path}' },
        { key: 'group', label: '分组', type: 'text', placeholder: '例如 开发' },
        { key: 'openIn', label: '打开方式', type: 'select', options: ['panel', 'host', 'browser'] },
        { key: 'icon', label: '图标', type: 'text', placeholder: '可选' },
      ],
      items: () => draft.cloud.bookmarks as unknown as AnyRecord[],
      replace: (items) => {
        draft.cloud.bookmarks = items as never;
      },
      make: () => ({
        id: uid('bookmark'),
        name: '新书签',
        url: '',
        group: '',
        openIn: 'panel',
        icon: '',
      }),
    },
    'cloud-webhooks': {
      id: 'cloud-webhooks',
      label: 'Webhook',
      hint: '保存后可在主页点击运行；URL 和 body 支持路径变量。',
      addLabel: '+ 添加 Webhook',
      fields: [
        { key: 'name', label: '名称', type: 'text', placeholder: '例如 部署通知' },
        { key: 'method', label: '方法', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        { key: 'url', label: '地址', type: 'text', placeholder: 'https://example.com/hook' },
        { key: 'body', label: 'Body', type: 'textarea', placeholder: '可选' },
      ],
      items: () => draft.cloud.webhooks as unknown as AnyRecord[],
      replace: (items) => {
        draft.cloud.webhooks = items as never;
      },
      make: () => ({ id: uid('webhook'), name: '新 Webhook', method: 'POST', url: '', body: '' }),
    },
  };

  const current = (): SectionDef => sections[sectionId];

  const orderedGuests = (): GuestSummary[] => {
    const order = new Map(draft.guests.order.map((id, index) => [id, index]));
    return [...options.guests].sort(
      (a, b) =>
        (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name),
    );
  };

  const moveGuest = (id: string, delta: number): void => {
    const ids = orderedGuests().map((guest) => guest.id);
    const index = ids.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target] as string, ids[index] as string];
    draft.guests.order = ids;
    render();
  };

  const renderGuests = (): void => {
    panelEl.append(
      h('div', { class: 'resource-head' }, [
        h('div', {}, [
          h('p', { class: 'resource-crumb', text: '默认资源 / 扩展' }),
          h('h3', { text: '扩展' }),
          h('p', { class: 'muted', text: sections.guests.hint }),
        ]),
        h('label', { class: 'switch' }, [
          h('input', {
            attrs: { type: 'checkbox', checked: draft.guests.enabled },
            on: {
              change: (event) => {
                draft.guests.enabled = (event.target as HTMLInputElement).checked;
              },
            },
          }),
          h('span'),
        ]),
      ]),
    );
    const list = h('div', { class: 'resource-list' });
    const guests = orderedGuests();
    if (!guests.length) {
      list.append(h('p', { class: 'empty', text: '没有检测到已安装的扩展。' }));
    }
    guests.forEach((guest, index) => {
      const hidden = draft.guests.hidden.includes(guest.id);
      list.append(
        h('div', { class: 'resource-item compact-row' }, [
          badge(hidden ? '隐藏' : '显示', hidden ? 'muted' : 'ok'),
          h('div', { class: 'resource-item-meta' }, [
            h('span', { class: 'resource-item-name', text: guest.name }),
            h('span', { class: 'resource-item-detail', text: `${guest.id}${guest.version ? ` · v${guest.version}` : ''}` }),
          ]),
          button(
            hidden ? '显示' : '隐藏',
            () => {
              draft.guests.hidden = hidden
                ? draft.guests.hidden.filter((id) => id !== guest.id)
                : [...draft.guests.hidden, guest.id];
              render();
            },
            { class: 'small' },
          ),
          button('↑', () => moveGuest(guest.id, -1), {
            class: 'small',
            disabled: index === 0,
            title: '上移',
          }),
          button('↓', () => moveGuest(guest.id, 1), {
            class: 'small',
            disabled: index === guests.length - 1,
            title: '下移',
          }),
        ]),
      );
    });
    panelEl.append(list);
  };

  const fieldControl = (item: AnyRecord, field: FieldDef): HTMLElement => {
    const value = item[field.key];
    if (field.type === 'checkbox') {
      return h('label', { class: 'resource-check' }, [
        h('input', {
          attrs: { type: 'checkbox', checked: value === true },
          on: {
            change: (event) => {
              item[field.key] = (event.target as HTMLInputElement).checked;
            },
          },
        }),
        h('span', { text: field.label }),
      ]);
    }
    if (field.type === 'select') {
      return h(
        'select',
        {
          class: 'input compact',
          on: {
            change: (event) => {
              item[field.key] = (event.target as HTMLSelectElement).value;
            },
          },
        },
        (field.options ?? []).map((option) =>
          h('option', {
            text: option,
            attrs: { value: option, selected: String(value ?? '') === option },
          }),
        ),
      );
    }
    if (field.type === 'textarea') {
      return h('textarea', {
        class: 'input resource-textarea',
        attrs: { rows: 3, placeholder: field.placeholder ?? '' },
        text: String(value ?? ''),
        on: {
          input: (event) => {
            item[field.key] = (event.target as HTMLTextAreaElement).value;
          },
        },
      });
    }
    const display =
      field.type === 'args' && Array.isArray(value) ? value.join(' ') : String(value ?? '');
    const input = h('input', {
      class: 'input',
      attrs: {
        type: field.type === 'number' ? 'number' : 'text',
        value: display,
        placeholder: field.placeholder ?? '',
      },
      on: {
        input: (event) => {
          const raw = (event.target as HTMLInputElement).value;
          if (field.type === 'number') item[field.key] = Number(raw);
          else if (field.type === 'args') item[field.key] = raw.split(/\s+/).filter(Boolean);
          else item[field.key] = raw;
        },
      },
    });
    if (!field.pick) return input;
    return h('div', { class: 'resource-pick' }, [
      input,
      button(
        '选择 EXE',
        () => {
          void (async () => {
            try {
              const picked = await options.onPickFile();
              if (!picked) return;
              item.command = picked;
              if (!item.name || item.name === '新应用') item.name = basename(picked);
              render();
            } catch (failure) {
              error.textContent = failure instanceof Error ? failure.message : String(failure);
            }
          })();
        },
        { class: 'small' },
      ),
    ]);
  };

  const renderSection = (): void => {
    const def = current();
    panelEl.append(
      h('div', { class: 'resource-head' }, [
        h('div', {}, [
          h('p', {
            class: 'resource-crumb',
            text: `默认资源 / ${navGroupFor(sectionId)} / ${def.label}`,
          }),
          h('h3', { text: def.label }),
          h('p', { class: 'muted', text: def.hint }),
        ]),
        button(
          def.addLabel,
          () => {
            def.items().push(def.make());
            render();
          },
          { variant: 'primary', class: 'small' },
        ),
      ]),
    );

    const list = h('div', { class: 'resource-list' });
    const items = def.items();
    if (!items.length) {
      list.append(h('p', { class: 'empty', text: '这个分组还没有内容，点击右上角添加。' }));
    }
    items.forEach((item, index) => {
      const head = h('div', { class: 'resource-item-head' }, [
        badge(def.label, 'info'),
        h('span', { class: 'resource-item-name', text: titleOf(item, index) }),
        h('span', { class: 'spacer' }),
        button('↑', () => {
          if (index <= 0) return;
          [items[index - 1], items[index]] = [items[index] as AnyRecord, items[index - 1] as AnyRecord];
          def.replace(items);
          render();
        }, { class: 'small', disabled: index === 0, title: '上移' }),
        button('↓', () => {
          if (index >= items.length - 1) return;
          [items[index + 1], items[index]] = [items[index] as AnyRecord, items[index + 1] as AnyRecord];
          def.replace(items);
          render();
        }, { class: 'small', disabled: index === items.length - 1, title: '下移' }),
        button('删除', () => {
          items.splice(index, 1);
          def.replace(items);
          render();
        }, { class: 'small', variant: 'danger' }),
      ]);
      const fields = h(
        'div',
        { class: 'resource-fields' },
        def.fields.map((field) =>
          h('label', { class: 'resource-field' }, [
            h('span', { class: 'resource-field-label', text: field.label }),
            fieldControl(item, field),
            field.hint ? h('span', { class: 'resource-field-hint', text: field.hint }) : null,
          ]),
        ),
      );
      list.append(h('div', { class: 'resource-item' }, [head, fields]));
    });
    panelEl.append(list);
  };

  const navGroupFor = (id: ResourceSection): string =>
    NAV.find((group) => group.sections.includes(id))?.label ?? '默认资源';

  const renderNav = (): void => {
    clear(navEl);
    for (const group of NAV) {
      navEl.append(
        h('div', { class: 'resource-nav-group' }, [
          h('div', { class: 'resource-nav-head' }, [
            h('span', { class: 'resource-nav-chevron', text: '▾' }),
            h('span', { class: 'resource-nav-title', text: group.label }),
            h('span', {
              class: 'resource-nav-count',
              text: String(group.sections.length),
            }),
          ]),
          h(
            'div',
            { class: 'resource-nav-children' },
            group.sections.map((id) =>
              h(
                'button',
                {
                  class: `resource-nav-item${id === sectionId ? ' active' : ''}`,
                  attrs: {
                    type: 'button',
                    'aria-current': id === sectionId ? 'page' : 'false',
                  },
                  on: {
                    click: () => {
                      sectionId = id;
                      render();
                    },
                  },
                },
                [
                  h('span', { class: 'resource-nav-dot' }),
                  h('span', { text: sections[id].label }),
                ],
              ),
            ),
          ),
        ]),
      );
    }
  };

  const render = (): void => {
    renderNav();
    clear(panelEl);
    if (sectionId === 'guests') renderGuests();
    else renderSection();
  };

  const overlay = h('div', {
    class: 'modal-overlay',
    on: {
      click: (event) => {
        if (event.target === overlay) close();
      },
    },
  });

  const close = (): void => {
    overlay.remove();
    options.onClose();
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    saving = true;
    error.textContent = '';
    try {
      draft.win11.apps = draft.win11.apps.filter((app) => app.name.trim() || app.command.trim());
      draft.win11.shardx = draft.win11.shardx.filter((instance) => instance.name.trim());
      draft.wsl.distros = draft.wsl.distros.filter((distro) => distro.name.trim());
      draft.wsl.ports = draft.wsl.ports.filter((port) => port.label.trim() && port.port > 0);
      draft.k8s.contexts = draft.k8s.contexts.filter((context) => context.name.trim());
      draft.k8s.portForwards = draft.k8s.portForwards.filter((forward) => forward.pod.trim());
      draft.cloud.bookmarks = draft.cloud.bookmarks.filter((bookmark) => bookmark.name.trim() && bookmark.url.trim());
      draft.cloud.webhooks = draft.cloud.webhooks.filter((webhook) => webhook.name.trim() && webhook.url.trim());
      draft.guests.order = orderedGuests().map((guest) => guest.id);
      await options.onSave({ groups: draft });
      close();
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure);
    } finally {
      saving = false;
    }
  };

  const modal = h('div', { class: 'modal wide resource-modal' }, [
    h('header', { class: 'modal-head' }, [
      h('div', { class: 'card-titles' }, [
        h('h2', { text: '资源管理' }),
        h('p', { class: 'card-subtitle', text: '编辑默认分组中的内容；保存后立即生效。' }),
      ]),
      h('span', { class: 'spacer' }),
      button('关闭', close),
    ]),
    h('div', { class: 'modal-body resource-layout' }, [navEl, panelEl]),
    h('footer', { class: 'modal-foot' }, [
      error,
      h('span', { class: 'spacer' }),
      button('取消', close),
      button('保存', () => void save(), { variant: 'primary' }),
    ]),
  ]);

  overlay.append(modal);
  document.body.append(overlay);
  render();
}
