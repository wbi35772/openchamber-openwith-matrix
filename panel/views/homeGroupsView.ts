/**
 * Home group editor.
 *
 * Groups are a user-owned layer on top of the six system sections: each group
 * can hold guest extensions, Windows apps, cloud bookmarks and arbitrary URLs
 * (for example a local service on a fixed port). The editor mutates a local
 * copy and saves the whole array in one `PUT /config` call.
 */

import type {
  AppSummary,
  CloudBookmark,
  GuestSummary,
  HomeGroup,
  HomeItem,
  HomeItemKind,
} from '../../shared/types.ts';
import { badge, button, clear, h } from '../dom.ts';

export interface HomeGroupsOptions {
  groups: HomeGroup[];
  guests: GuestSummary[];
  apps: AppSummary[];
  bookmarks: CloudBookmark[];
  onSave(groups: HomeGroup[]): Promise<void>;
  onClose(): void;
}

const KIND_LABELS: Record<HomeItemKind, string> = {
  guest: '扩展',
  app: '应用',
  bookmark: '书签',
  url: '链接',
};

const KINDS: HomeItemKind[] = ['guest', 'app', 'bookmark', 'url'];

let counter = 0;

const uid = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(counter += 1).toString(36)}`;

export function openHomeGroups(options: HomeGroupsOptions): void {
  const groups: HomeGroup[] = structuredClone(options.groups);
  let selectedId: string | null = groups[0]?.id ?? null;
  let draftKind: HomeItemKind = 'guest';
  let draftRef = '';
  let draftLabel = '';
  let draftUrl = '';
  let saving = false;

  const error = h('p', { class: 'error-text' });
  const listEl = h('div', { class: 'group-list' });
  const detailEl = h('div', { class: 'group-detail' });

  const current = (): HomeGroup | null => groups.find((group) => group.id === selectedId) ?? null;

  const resourceList = (
    kind: HomeItemKind,
  ): Array<{ id: string; name: string; detail?: string }> => {
    if (kind === 'guest') {
      return options.guests.map((guest) => ({
        id: guest.id,
        name: guest.name,
        detail: guest.version ? `v${guest.version}` : guest.id,
      }));
    }
    if (kind === 'app') {
      return options.apps.map((app) => ({ id: app.id, name: app.name, detail: app.command }));
    }
    if (kind === 'bookmark') {
      return options.bookmarks.map((bookmark) => ({
        id: bookmark.id,
        name: bookmark.name,
        detail: bookmark.url,
      }));
    }
    return [];
  };

  const describe = (item: HomeItem): { label: string; detail: string } => {
    if (item.kind === 'guest') {
      const guest = options.guests.find((entry) => entry.id === item.ref);
      return { label: item.label ?? guest?.name ?? item.ref, detail: `扩展 · ${item.ref}` };
    }
    if (item.kind === 'app') {
      const app = options.apps.find((entry) => entry.id === item.ref);
      return { label: item.label ?? app?.name ?? item.ref, detail: `应用 · ${item.ref}` };
    }
    if (item.kind === 'bookmark') {
      const bookmark = options.bookmarks.find((entry) => entry.id === item.ref);
      return { label: item.label ?? bookmark?.name ?? item.ref, detail: `书签 · ${item.ref}` };
    }
    return { label: item.label ?? item.ref, detail: `链接 · ${item.ref}` };
  };

  const overlay = h('div', {
    class: 'modal-overlay',
    on: {
      click: (event) => {
        if (event.target === overlay) close();
      },
    },
  });
  const modal = h('div', { class: 'modal wide' });

  const close = (): void => {
    overlay.remove();
    options.onClose();
  };

  const renderList = (): void => {
    clear(listEl);
    listEl.append(h('div', { class: 'group-list-head', text: '分组' }));
    for (const group of groups) {
      listEl.append(
        h(
          'button',
          {
            class: `group-list-item${group.id === selectedId ? ' active' : ''}`,
            attrs: { type: 'button' },
            on: {
              click: () => {
                selectedId = group.id;
                render();
              },
            },
          },
          [
            h('span', { class: 'group-list-name', text: group.name || '未命名分组' }),
            badge(String(group.items.length), 'muted'),
          ],
        ),
      );
    }
    listEl.append(
      button(
        '+ 新建分组',
        () => {
          const group: HomeGroup = {
            id: uid('group'),
            name: `新分组 ${groups.length + 1}`,
            items: [],
          };
          groups.push(group);
          selectedId = group.id;
          render();
        },
        { variant: 'primary', class: 'group-add-button' },
      ),
    );
  };

  const renderDetail = (): void => {
    clear(detailEl);
    const group = current();
    if (!group) {
      detailEl.append(h('p', { class: 'empty', text: '选择左侧分组，或新建一个分组。' }));
      return;
    }

    const nameInput = h('input', {
      class: 'input',
      attrs: { type: 'text', value: group.name, placeholder: '分组名称' },
      on: {
        input: (event) => {
          group.name = (event.target as HTMLInputElement).value;
          renderList();
        },
      },
    });

    const itemsEl = h('div', { class: 'group-items' });
    if (!group.items.length) {
      itemsEl.append(h('p', { class: 'empty', text: '这个分组还没有项目。' }));
    }
    group.items.forEach((item, index) => {
      const info = describe(item);
      itemsEl.append(
        h('div', { class: 'group-item-row' }, [
          badge(KIND_LABELS[item.kind], 'info'),
          h('div', { class: 'group-item-meta' }, [
            h('span', { class: 'group-item-name', text: info.label }),
            h('span', { class: 'group-item-detail', text: info.detail }),
          ]),
          button(
            '↑',
            () => {
              if (index <= 0) return;
              const previous = group.items[index - 1];
              const currentItem = group.items[index];
              if (!previous || !currentItem) return;
              group.items[index - 1] = currentItem;
              group.items[index] = previous;
              renderDetail();
            },
            { class: 'small', disabled: index === 0, title: '上移' },
          ),
          button(
            '↓',
            () => {
              if (index >= group.items.length - 1) return;
              const next = group.items[index + 1];
              const currentItem = group.items[index];
              if (!next || !currentItem) return;
              group.items[index + 1] = currentItem;
              group.items[index] = next;
              renderDetail();
            },
            { class: 'small', disabled: index === group.items.length - 1, title: '下移' },
          ),
          button(
            '移除',
            () => {
              group.items.splice(index, 1);
              renderDetail();
            },
            { class: 'small', variant: 'danger' },
          ),
        ]),
      );
    });

    const kindSelect = h(
      'select',
      {
        class: 'input compact',
        on: {
          change: (event) => {
            draftKind = (event.target as HTMLSelectElement).value as HomeItemKind;
            draftRef = '';
            renderDetail();
          },
        },
      },
      KINDS.map((kind) =>
        h('option', {
          text: KIND_LABELS[kind],
          attrs: { value: kind, selected: kind === draftKind },
        }),
      ),
    );

    let refControl: HTMLElement;
    let addHandler: () => void;

    if (draftKind === 'url') {
      const urlInput = h('input', {
        class: 'input',
        attrs: { type: 'url', placeholder: 'https://…', value: draftUrl, spellcheck: 'false' },
        on: {
          input: (event) => {
            draftUrl = (event.target as HTMLInputElement).value;
          },
        },
      });
      const labelInput = h('input', {
        class: 'input',
        attrs: { type: 'text', placeholder: '显示名称（可选）', value: draftLabel },
        on: {
          input: (event) => {
            draftLabel = (event.target as HTMLInputElement).value;
          },
        },
      });
      refControl = h('div', { class: 'group-add-fields' }, [urlInput, labelInput]);
      addHandler = () => {
        const url = draftUrl.trim();
        if (!url) {
          error.textContent = '请填写链接地址';
          return;
        }
        group.items.push({
          id: uid('item'),
          kind: 'url',
          ref: url,
          label: draftLabel.trim() || url,
        });
        draftUrl = '';
        draftLabel = '';
        error.textContent = '';
        renderDetail();
      };
    } else {
      const resources = resourceList(draftKind);
      if (!resources.some((resource) => resource.id === draftRef)) {
        draftRef = resources[0]?.id ?? '';
      }
      if (resources.length) {
        refControl = h(
          'select',
          {
            class: 'input compact',
            on: {
              change: (event) => {
                draftRef = (event.target as HTMLSelectElement).value;
              },
            },
          },
          resources.map((resource) =>
            h('option', {
              text: resource.detail ? `${resource.name} · ${resource.detail}` : resource.name,
              attrs: { value: resource.id, selected: resource.id === draftRef },
            }),
          ),
        );
      } else {
        refControl = h('span', { class: 'muted group-add-empty', text: '没有可用资源' });
      }
      addHandler = () => {
        const resource = resources.find((entry) => entry.id === draftRef);
        if (!resource) {
          error.textContent = '请选择要添加的资源';
          return;
        }
        group.items.push({
          id: uid('item'),
          kind: draftKind,
          ref: resource.id,
          label: resource.name,
        });
        error.textContent = '';
        renderDetail();
      };
    }

    detailEl.append(
      h('div', { class: 'group-detail-head' }, [
        nameInput,
        button(
          '删除分组',
          () => {
            const index = groups.findIndex((entry) => entry.id === group.id);
            if (index >= 0) groups.splice(index, 1);
            selectedId = groups[Math.max(0, index - 1)]?.id ?? groups[0]?.id ?? null;
            render();
          },
          { variant: 'danger' },
        ),
      ]),
      h('h3', { class: 'group-detail-title', text: `项目 · ${group.items.length}` }),
      itemsEl,
      h('div', { class: 'group-add' }, [
        h('span', { class: 'group-add-title', text: '添加项目' }),
        kindSelect,
        refControl,
        button('添加', addHandler, { variant: 'primary' }),
      ]),
    );
  };

  const render = (): void => {
    renderList();
    renderDetail();
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    saving = true;
    error.textContent = '';
    try {
      const cleaned: HomeGroup[] = groups.map((group) => ({
        ...group,
        name: group.name.trim() || '未命名分组',
        items: group.items.map((item) => ({
          ...item,
          label: item.label?.trim() || undefined,
        })),
      }));
      await options.onSave(cleaned);
      close();
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure);
    } finally {
      saving = false;
    }
  };

  modal.append(
    h('header', { class: 'modal-head' }, [
      h('div', { class: 'card-titles' }, [
        h('h2', { text: '主页分组' }),
        h('p', {
          class: 'card-subtitle',
          text: '把扩展、应用、书签和本地端口应用按用途放到一起',
        }),
      ]),
      h('span', { class: 'spacer' }),
      button('关闭', close),
    ]),
    h('div', { class: 'modal-body group-editor' }, [listEl, detailEl]),
    h('footer', { class: 'modal-foot' }, [
      error,
      h('span', { class: 'spacer' }),
      button('取消', close),
      button('保存分组', () => void save(), { variant: 'primary' }),
    ]),
  );

  overlay.append(modal);
  document.body.append(overlay);
  render();
}
