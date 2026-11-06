/**
 * Home tab editor.
 *
 * Built-in tabs can be renamed, reordered, hidden and given a view mode, but
 * never deleted. Custom groups get one tab each; that tab's label follows the
 * group name and can be removed (the group itself stays in the group editor).
 * The editor mutates a local copy and saves the whole array in one PUT.
 */

import {
  DEFAULT_HOME_SECTIONS,
  type HomeGroup,
  type HomeSectionConfig,
  type HomeViewMode,
} from '../../shared/types.ts';
import { badge, button, clear, h } from '../dom.ts';

export interface HomeTabsOptions {
  sections: HomeSectionConfig[];
  groups: HomeGroup[];
  onSave(sections: HomeSectionConfig[]): Promise<void>;
  onClose(): void;
}

const VIEW_LABELS: Record<HomeViewMode, string> = {
  list: '列表',
  cards: '卡片',
  compact: '紧凑',
};

const VIEWS: HomeViewMode[] = ['list', 'cards', 'compact'];

const KIND_LABELS: Record<HomeSectionConfig['kind'], string> = {
  guests: '扩展',
  'win11-apps': '应用',
  shardx: 'ShardX',
  'wsl-ports': 'WSL 端口',
  'docker-containers': '容器',
  'k8s-forwards': '端口转发',
  'cloud-bookmarks': '书签',
  'cloud-webhooks': 'Webhook',
  'custom-group': '自定义分组',
};

export function openHomeTabs(options: HomeTabsOptions): void {
  const sections: HomeSectionConfig[] = structuredClone(options.sections);
  let saving = false;

  const error = h('p', { class: 'error-text' });
  const listEl = h('div', { class: 'tabs-editor' });

  const overlay = h('div', {
    class: 'modal-overlay',
    on: {
      click: (event) => {
        if (event.target === overlay) close();
      },
    },
  });
  const modal = h('div', { class: 'modal' });

  const close = (): void => {
    overlay.remove();
    options.onClose();
  };

  const groupName = (section: HomeSectionConfig): string =>
    options.groups.find((group) => group.id === section.groupId)?.name ?? section.label;

  const move = (section: HomeSectionConfig, delta: number): void => {
    const active = sections.filter((entry) => !entry.removed);
    const index = active.indexOf(section);
    const target = active[index + delta];
    if (index < 0 || !target) return;
    const from = sections.indexOf(section);
    const to = sections.indexOf(target);
    [sections[from], sections[to]] = [sections[to], sections[from]];
    render();
  };

  const render = (): void => {
    clear(listEl);

    const active = sections.filter((section) => !section.removed);
    const removed = sections.filter((section) => section.removed);

    active.forEach((section, index) => {
      const custom = section.kind === 'custom-group';
      const labelInput = h('input', {
        class: 'input',
        attrs: {
          type: 'text',
          value: custom ? groupName(section) : section.label,
          placeholder: '标签名称',
          disabled: custom,
          title: custom ? '自定义分组标签随分组名称' : '修改标签名称',
        },
        on: {
          input: (event) => {
            section.label = (event.target as HTMLInputElement).value;
          },
        },
      });

      const viewSelect = h(
        'select',
        {
          class: 'input compact',
          attrs: { title: '默认视图样式' },
          on: {
            change: (event) => {
              section.view = (event.target as HTMLSelectElement).value as HomeViewMode;
            },
          },
        },
        VIEWS.map((view) =>
          h('option', {
            text: VIEW_LABELS[view],
            attrs: { value: view, selected: view === section.view },
          }),
        ),
      );

      const row = h(
        'div',
        {
          class: `tab-config-row${section.visible ? '' : ' hidden'}${
            custom ? ' custom' : ''
          }`,
        },
        [
          h('span', { class: 'tab-config-order', text: String(index + 1) }),
          h('div', { class: 'tab-config-main' }, [
            labelInput,
            h('span', {
              class: 'tab-config-kind',
              text: custom ? '自定义分组 · 名称随分组' : KIND_LABELS[section.kind],
            }),
          ]),
          viewSelect,
          button(
            section.visible ? '隐藏' : '显示',
            () => {
              section.visible = !section.visible;
              render();
            },
            {
              class: 'small',
              variant: section.visible ? 'ghost' : 'primary',
              title: section.visible ? '点击隐藏这个标签' : '点击重新显示',
            },
          ),
          button('↑', () => move(section, -1), {
            class: 'small',
            disabled: index === 0,
            title: '上移',
          }),
          button('↓', () => move(section, 1), {
            class: 'small',
            disabled: index === active.length - 1,
            title: '下移',
          }),
          button(
            '删除',
            () => {
              section.removed = true;
              section.visible = false;
              render();
            },
            {
              class: 'small',
              variant: 'danger',
              title: custom ? '删除这个分组标签（分组仍保留）' : '删除这个内置标签，可在下方恢复',
            },
          ),
        ],
      );
      listEl.append(row);
    });

    if (removed.length) {
      listEl.append(
        h('div', { class: 'tabs-editor-removed' }, [
          h('p', {
            class: 'tabs-editor-removed-title',
            text: `已删除的标签（${removed.length}）`,
          }),
          ...removed.map((section) => {
            const custom = section.kind === 'custom-group';
            return h('div', { class: 'tab-config-row removed' }, [
              h('span', { class: 'tab-config-order', text: '—' }),
              h('div', { class: 'tab-config-main' }, [
                h('span', {
                  class: 'tab-config-label',
                  text: custom ? groupName(section) : section.label,
                }),
                h('span', {
                  class: 'tab-config-kind',
                  text: custom ? '自定义分组' : KIND_LABELS[section.kind],
                }),
              ]),
              badge('已删除', 'muted'),
              button(
                '恢复',
                () => {
                  section.removed = false;
                  section.visible = true;
                  render();
                },
                { class: 'small', variant: 'primary', title: '恢复到标签栏' },
              ),
            ]);
          }),
        ]),
      );
    }

    const availableGroups = options.groups.filter(
      (group) =>
        !sections.some(
          (section) => section.kind === 'custom-group' && section.groupId === group.id,
        ),
    );
    if (availableGroups.length) {
      const groupSelect = h(
        'select',
        { class: 'input compact' },
        availableGroups.map((group) =>
          h('option', { text: group.name || '未命名分组', attrs: { value: group.id } }),
        ),
      );
      listEl.append(
        h('div', { class: 'tab-config-add' }, [
          groupSelect,
          button(
            '+ 添加分组标签',
            () => {
              const selected = groupSelect.value;
              const group = options.groups.find((entry) => entry.id === selected);
              if (!group) return;
              sections.push({
                id: `group:${group.id}`,
                kind: 'custom-group',
                label: group.name || '自定义分组',
                view: 'cards',
                visible: true,
                groupId: group.id,
              });
              render();
            },
            { variant: 'primary' },
          ),
        ]),
      );
    } else {
      listEl.append(
        h('p', {
          class: 'tab-config-note',
          text: options.groups.length
            ? '每个自定义分组都已经有标签。新建分组后可以在这里添加。'
            : '还没有自定义分组，可先在“主页分组”里新建。',
        }),
      );
    }
  };

  const restore = (): void => {
    const seen = new Set<HomeSectionConfig['kind']>();
    const next = sections.map((section) => {
      if (section.kind === 'custom-group') return section;
      const fallback = DEFAULT_HOME_SECTIONS.find((entry) => entry.kind === section.kind);
      if (!fallback) return section;
      seen.add(fallback.kind);
      return {
        ...section,
        label: fallback.label,
        view: fallback.view,
        visible: true,
        removed: false,
      };
    });
    for (const fallback of DEFAULT_HOME_SECTIONS) {
      if (!seen.has(fallback.kind)) next.push({ ...fallback });
    }
    sections.splice(0, sections.length, ...next);
    render();
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    saving = true;
    error.textContent = '';
    try {
      const cleaned = sections.map((section) => {
        const label = section.label.trim();
        const { removed, ...rest } = section;
        return {
          ...rest,
          ...(removed ? { removed: true } : {}),
          label:
            label ||
            (section.kind === 'custom-group'
              ? options.groups.find((group) => group.id === section.groupId)?.name || '自定义分组'
              : KIND_LABELS[section.kind]),
        };
      });
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
        h('h2', { text: '主页标签' }),
        h('p', {
          class: 'card-subtitle',
          text: '改名、排序、隐藏或删除，或给每个标签选一种视图样式',
        }),
      ]),
      h('span', { class: 'spacer' }),
      button('关闭', close),
    ]),
    h('div', { class: 'modal-body' }, [
      h('p', {
        class: 'tab-config-hint',
        text: '内置标签和自定义分组标签都可以改名、排序、隐藏或删除；删除后可在下方恢复。',
      }),
      listEl,
    ]),
    h('footer', { class: 'modal-foot' }, [
      error,
      h('span', { class: 'spacer' }),
      button('恢复内置标签', restore),
      button('取消', close),
      button('保存标签', () => void save(), { variant: 'primary' }),
    ]),
  );

  overlay.append(modal);
  document.body.append(overlay);
  render();
}
