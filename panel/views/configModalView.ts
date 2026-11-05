/**
 * Configuration modal.
 *
 * The whole matrix config is editable as JSON: the store deep-merges objects
 * and replaces arrays, so advanced users can add bookmarks, webhooks, WSL ports
 * and ShardX slots without a bespoke form for every group.
 */

import type { MatrixConfig } from '../../shared/types.ts';
import { button, clear, h } from '../dom.ts';

export interface ConfigModalOptions {
  config: MatrixConfig;
  path: string;
  onSave(patch: unknown): Promise<void>;
  onReset(): Promise<void>;
  onClose(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function openConfigModal(options: ConfigModalOptions): void {
  const error = h('p', { class: 'error-text' });
  const textarea = h('textarea', {
    class: 'config-json',
    attrs: { spellcheck: 'false', rows: 22 },
  });
  textarea.value = JSON.stringify(options.config, null, 2);

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

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };

  const save = button(
    '保存配置',
    () => {
      error.textContent = '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(textarea.value);
      } catch (parseError) {
        error.textContent = `JSON 解析失败：${messageOf(parseError)}`;
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        error.textContent = '配置必须是一个 JSON 对象';
        return;
      }
      save.disabled = true;
      void options
        .onSave(parsed)
        .then(() => close())
        .catch((saveError: unknown) => {
          error.textContent = messageOf(saveError);
          save.disabled = false;
        });
    },
    { variant: 'primary' },
  );

  const reset = button(
    '恢复默认',
    () => {
      if (!window.confirm('恢复默认配置？当前自定义内容会被覆盖。')) return;
      error.textContent = '';
      reset.disabled = true;
      void options
        .onReset()
        .then(() => close())
        .catch((resetError: unknown) => {
          error.textContent = messageOf(resetError);
          reset.disabled = false;
        });
    },
    { variant: 'danger' },
  );

  const format = button('格式化', () => {
    try {
      textarea.value = JSON.stringify(JSON.parse(textarea.value), null, 2);
      error.textContent = '';
    } catch (formatError) {
      error.textContent = `JSON 解析失败：${messageOf(formatError)}`;
    }
  });

  overlay.append(
    h('div', { class: 'modal' }, [
      h('header', { class: 'modal-head' }, [
        h('div', {}, [
          h('h2', { text: '矩阵配置' }),
          h('p', { class: 'muted', text: options.path }),
        ]),
        button('关闭', close, { title: '关闭（Esc）' }),
      ]),
      h('div', { class: 'modal-body' }, [
        h('p', {
          class: 'muted',
          text: '对象会深度合并，数组整体替换。保存后立即生效，服务与面板会自动刷新。',
        }),
        textarea,
        error,
      ]),
      h('footer', { class: 'modal-foot' }, [
        format,
        reset,
        h('span', { class: 'spacer' }),
        button('取消', close),
        save,
      ]),
    ]),
  );

  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  textarea.focus();
  clear(error);
}
