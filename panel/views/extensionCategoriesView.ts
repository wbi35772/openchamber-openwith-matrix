/**
 * Extension category editor.
 *
 * Categories and guest assignments live in `config.extensionLibrary`. The
 * editor renames, reorders, adds and removes categories, and moves installed
 * extensions between them. Everything is kept in a local draft and saved with
 * one `PUT /config` call.
 */

import {
  DEFAULT_EXTENSION_ASSIGNMENTS,
  DEFAULT_EXTENSION_CATEGORIES,
  type ExtensionCategoryConfig,
  type ExtensionLibraryConfig,
  type GuestSummary,
  type MatrixConfig,
} from '../../shared/types.ts';
import { categoryClass, fallbackCategoryId, libraryOf } from '../extensionCatalog.ts';
import { button, clear, h } from '../dom.ts';

export interface ExtensionCategoriesOptions {
  config: MatrixConfig;
  guests: GuestSummary[];
  onSave(library: ExtensionLibraryConfig): Promise<void>;
  onClose(): void;
}

let counter = 0;

const newCategoryId = (): string => {
  counter += 1;
  return `custom-${Date.now().toString(36)}-${counter.toString(36)}`;
};

export function openExtensionCategories(options: ExtensionCategoriesOptions): void {
  const library = libraryOf(options.config);
  const categories: ExtensionCategoryConfig[] = structuredClone(library.categories);
  const assignments: Record<string, string> = {};
  for (const guest of options.guests) {
    assignments[guest.id] = library.assignments[guest.id] ?? fallbackCategoryId(library);
  }

  let saving = false;
  let query = '';

  const error = h('p', { class: 'error-text' });
  const categoryList = h('div', { class: 'cat-editor-list' });
  const assignList = h('div', { class: 'cat-assign-list' });
  const countLabel = h('span', { class: 'cat-editor-count' });

  const overlay = h('div', {
    class: 'modal-overlay',
    on: {
      click: (event) => {
        if (event.target === overlay) close();
      },
    },
  });

  const close = (): void => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    options.onClose();
  };

  const currentFallback = (): string => {
    const other = categories.find((category) => category.id === 'other');
    return other?.id ?? categories[categories.length - 1]?.id ?? '';
  };

  const countOf = (categoryId: string): number =>
    options.guests.filter((guest) => assignments[guest.id] === categoryId).length;

  const renderCategories = (): void => {
    clear(categoryList);
    categories.forEach((category, index) => {
      const name = h('input', {
        class: 'input compact cat-name-input',
        attrs: {
          value: category.name,
          placeholder: '分类名称',
          maxlength: 24,
          'aria-label': '分类名称',
        },
        on: {
          input: (event) => {
            category.name = (event.target as HTMLInputElement).value;
          },
        },
      });

      const up = button(
        '↑',
        () => {
          if (index === 0) return;
          const [moved] = categories.splice(index, 1);
          if (moved) categories.splice(index - 1, 0, moved);
          renderCategories();
          renderAssignments();
        },
        { class: 'small icon-button', disabled: index === 0, title: '上移' },
      );

      const down = button(
        '↓',
        () => {
          if (index >= categories.length - 1) return;
          const [moved] = categories.splice(index, 1);
          if (moved) categories.splice(index + 1, 0, moved);
          renderCategories();
          renderAssignments();
        },
        {
          class: 'small icon-button',
          disabled: index >= categories.length - 1,
          title: '下移',
        },
      );

      const remove = button(
        '✕',
        () => {
          if (categories.length <= 1) return;
          const removed = category.id;
          categories.splice(index, 1);
          const fallback = currentFallback();
          for (const guest of options.guests) {
            if (assignments[guest.id] === removed) assignments[guest.id] = fallback;
          }
          renderCategories();
          renderAssignments();
        },
        {
          class: 'small danger',
          disabled: categories.length <= 1,
          title: categories.length <= 1 ? '至少保留一个分类' : '删除分类，扩展移到最后一个分类',
        },
      );

      categoryList.append(
        h('div', { class: 'cat-editor-row' }, [
          h('span', { class: `guest-group-dot ${categoryClass(index)}` }),
          name,
          h('span', { class: 'cat-editor-count', text: String(countOf(category.id)) }),
          h('div', { class: 'cat-editor-actions' }, [up, down, remove]),
        ]),
      );
    });

    countLabel.textContent = `${categories.length} 个分类 · ${options.guests.length} 个扩展 · 拖尾分类接收未归类的扩展`;
  };

  const renderAssignments = (): void => {
    clear(assignList);
    const needle = query.trim().toLowerCase();
    const visible = options.guests.filter((guest) =>
      needle ? `${guest.name} ${guest.id}`.toLowerCase().includes(needle) : true,
    );
    if (!visible.length) {
      assignList.append(h('p', { class: 'empty', text: '没有匹配的扩展' }));
      return;
    }
    for (const guest of visible) {
      const select = h(
        'select',
        {
          class: 'input compact',
          attrs: { 'aria-label': `${guest.name} 分类` },
          on: {
            change: (event) => {
              assignments[guest.id] = (event.target as HTMLSelectElement).value;
              renderCategories();
            },
          },
        },
        categories.map((category) =>
          h('option', {
            attrs: {
              value: category.id,
              selected: assignments[guest.id] === category.id,
            },
            text: category.name || category.id,
          }),
        ),
      );

      assignList.append(
        h('label', { class: 'cat-assign-row' }, [
          h('span', { class: 'cat-assign-name' }, [
            h('span', { class: 'cat-assign-title', text: guest.name }),
            h('span', { class: 'cat-assign-id', text: guest.id }),
          ]),
          select,
        ]),
      );
    }
  };

  const add = button(
    '新增分类',
    () => {
      categories.push({ id: newCategoryId(), name: `新分类 ${categories.length + 1}` });
      renderCategories();
      renderAssignments();
    },
    { class: 'small' },
  );

  const search = h('input', {
    class: 'input search',
    attrs: { type: 'search', placeholder: '筛选扩展…', value: query },
    on: {
      input: (event) => {
        query = (event.target as HTMLInputElement).value;
        renderAssignments();
      },
    },
  });

  const save = button(
    '保存分类',
    () => {
      error.textContent = '';
      if (!categories.length) {
        error.textContent = '至少需要一个分类';
        return;
      }
      const cleaned = categories.map((category, index) => ({
        id: category.id,
        name: category.name.trim().slice(0, 24) || `分类 ${index + 1}`,
      }));
      const known = new Set(cleaned.map((category) => category.id));
      const fallback = known.has('other') ? 'other' : cleaned[cleaned.length - 1]!.id;
      const finalAssignments: Record<string, string> = {};
      for (const guest of options.guests) {
        const wanted = assignments[guest.id];
        finalAssignments[guest.id] = wanted && known.has(wanted) ? wanted : fallback;
      }
      saving = true;
      save.disabled = true;
      void options
        .onSave({ categories: cleaned, assignments: finalAssignments })
        .then(() => close())
        .catch((saveError: unknown) => {
          saving = false;
          save.disabled = false;
          error.textContent = saveError instanceof Error ? saveError.message : String(saveError);
        });
    },
    { variant: 'primary' },
  );

  const reset = button(
    '恢复默认',
    () => {
      if (!window.confirm('恢复默认分类与归属？当前自定义分类会被覆盖。')) return;
      categories.splice(0, categories.length, ...structuredClone(DEFAULT_EXTENSION_CATEGORIES));
      const known = new Set(categories.map((category) => category.id));
      for (const guest of options.guests) {
        const wanted = DEFAULT_EXTENSION_ASSIGNMENTS[guest.id];
        assignments[guest.id] = wanted && known.has(wanted) ? wanted : currentFallback();
      }
      renderCategories();
      renderAssignments();
    },
    { class: 'small' },
  );

  overlay.append(
    h('div', { class: 'modal wide cat-editor-modal' }, [
      h('header', { class: 'modal-head' }, [
        h('div', {}, [
          h('h2', { text: '扩展分类' }),
          h('p', {
            class: 'muted',
            text: '修改分类名称、顺序与扩展归属；保存后立即刷新扩展列表。',
          }),
        ]),
        button('关闭', close, { title: '关闭（Esc）' }),
      ]),
      h('div', { class: 'modal-body cat-editor-body' }, [
        h('section', { class: 'cat-editor-pane' }, [
          h('div', { class: 'cat-editor-pane-head' }, [
            h('h3', { text: '分类定义' }),
            countLabel,
            h('span', { class: 'spacer' }),
            add,
          ]),
          categoryList,
        ]),
        h('section', { class: 'cat-editor-pane' }, [
          h('div', { class: 'cat-editor-pane-head' }, [
            h('h3', { text: '扩展归属' }),
            h('span', { class: 'spacer' }),
            search,
          ]),
          assignList,
          error,
        ]),
      ]),
      h('footer', { class: 'modal-foot' }, [
        reset,
        h('span', { class: 'spacer' }),
        button('取消', close),
        save,
      ]),
    ]),
  );

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !saving) close();
  };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  renderCategories();
  renderAssignments();
}
