/**
 * Log stream pane: pick a source, subscribe through the service and poll the
 * subscription. The pane owns its timer so switching tabs keeps the stream
 * alive; closing the tab stops the subscription.
 */

import type {
  LogChunk,
  LogOutput,
  LogSourceInfo,
  LogSubscriptionInfo,
} from '../../shared/types.ts';
import { badge, button, clear, empty, errorText, h } from '../dom.ts';

export interface LogPaneActions {
  create(sourceId: string): Promise<LogSubscriptionInfo>;
  poll(subscriptionId: string, since: number): Promise<LogOutput>;
  stop(subscriptionId: string): Promise<void>;
  compose(text: string): void;
  persist(patch: { subscriptionId?: string | null; sourceId?: string | null }): void;
}

export interface LogPaneOptions {
  sources: LogSourceInfo[];
  sourceId: string | null;
  subscriptionId: string | null;
}

export interface LogPaneHandle {
  destroy(): void;
}

const MAX_CHUNKS = 600;
const POLL_MS = 1_200;

const chunkLine = (chunk: LogChunk): HTMLElement =>
  h('span', {
    class: chunk.stream === 'stderr' ? 'log-line stderr' : 'log-line',
    text: chunk.text.endsWith('\n') ? chunk.text : `${chunk.text}\n`,
  });

export function createLogPane(
  container: HTMLElement,
  options: LogPaneOptions,
  actions: LogPaneActions,
): LogPaneHandle {
  let sources = options.sources;
  let sourceId = options.sourceId;
  let subscriptionId = options.subscriptionId;
  let seq = 0;
  let timer: number | null = null;
  let destroyed = false;
  let alive = false;
  let lastError: string | null = null;

  const status = h('span', { class: 'pane-status', text: '未连接' });
  const output = h('div', { class: 'log-output' });
  const toolbar = h('div', { class: 'pane-toolbar' });

  const stopTimer = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const setStatus = (text: string, tone: 'ok' | 'warn' | 'error' | 'muted'): void => {
    status.textContent = text;
    status.className = `pane-status ${tone}`;
  };

  const append = (chunks: LogChunk[]): void => {
    const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 80;
    for (const chunk of chunks) output.append(chunkLine(chunk));
    while (output.childElementCount > MAX_CHUNKS) output.firstElementChild?.remove();
    if (nearBottom) output.scrollTop = output.scrollHeight;
  };

  const transcript = (): string => {
    const lines: string[] = [];
    for (const node of Array.from(output.children).slice(-200)) {
      lines.push(node.textContent ?? '');
    }
    return lines.join('');
  };

  const poll = async (): Promise<void> => {
    if (destroyed || !subscriptionId) return;
    const id = subscriptionId;
    try {
      const chunk = await actions.poll(id, seq);
      if (destroyed || subscriptionId !== id) return;
      append(chunk.chunks);
      seq = chunk.nextSeq;
      alive = chunk.alive;
      lastError = chunk.error ?? null;
      if (chunk.error) setStatus(chunk.error, 'error');
      else if (chunk.alive) setStatus(`流式 · ${seq} 条`, 'ok');
      else setStatus('已结束', 'muted');
      if (chunk.truncated) append([{ seq, sourceId: sourceId ?? '', stream: 'stderr', text: '… 早先日志已截断 …\n', at: Date.now() }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('subscription-not-found') && sourceId) {
        subscriptionId = null;
        actions.persist({ subscriptionId: null });
        setStatus('重新订阅…', 'muted');
        void start();
        return;
      }
      lastError = message;
      setStatus(lastError, 'error');
    }
    if (alive && !destroyed) timer = window.setTimeout(() => void poll(), POLL_MS);
  };

  const start = async (): Promise<void> => {
    if (!sourceId) return;
    setStatus('订阅中…', 'muted');
    try {
      const subscription = await actions.create(sourceId);
      subscriptionId = subscription.id;
      seq = 0;
      alive = true;
      output.replaceChildren();
      actions.persist({ subscriptionId, sourceId });
      renderToolbar();
      setStatus('已连接', 'ok');
      void poll();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const stop = async (): Promise<void> => {
    stopTimer();
    const id = subscriptionId;
    subscriptionId = null;
    alive = false;
    actions.persist({ subscriptionId: null });
    if (id) {
      try {
        await actions.stop(id);
      } catch {
        /* the source may already be gone */
      }
    }
    renderToolbar();
    setStatus('已停止', 'muted');
  };

  const renderToolbar = (): void => {
    clear(toolbar);
    const select = h(
      'select',
      {
        class: 'input compact',
        on: {
          change: (event) => {
            sourceId = (event.target as HTMLSelectElement).value || null;
          },
        },
      },
      [
        h('option', { text: '选择日志源', attrs: { value: '' } }),
        ...sources.map((source) =>
          h('option', {
            text: `${source.name}${source.available ? '' : '（不可用）'}`,
            attrs: { value: source.id, selected: source.id === sourceId, disabled: !source.available },
          }),
        ),
      ],
    );

    toolbar.append(
      h('div', { class: 'toolbar-group' }, [
        select,
        button(subscriptionId ? '重新订阅' : '开始', () => void start(), { variant: 'primary' }),
        subscriptionId ? button('停止', () => void stop(), { variant: 'danger' }) : null,
      ]),
      h('div', { class: 'toolbar-group' }, [
        button('发送到 AI', () => {
          const text = transcript().trim();
          if (!text) return;
          const clipped =
            text.length > 12_000 ? `… 早先日志已截断 …\n${text.slice(-12_000)}` : text;
          actions.compose(`以下是日志流输出：\n\n\`\`\`\n${clipped}\n\`\`\`\n`);
        }),
        button('清空', () => output.replaceChildren()),
        status,
      ]),
    );
  };

  container.append(
    h('div', { class: 'pane-shell' }, [
      h('div', { class: 'pane-head' }, [
        h('div', { class: 'pane-title' }, [h('span', { text: '日志流' }), badge('log', 'info')]),
        toolbar,
      ]),
      h('div', { class: 'pane-body log-body' }, [
        sources.length ? null : empty('配置中没有日志源'),
        output,
        lastError ? errorText(lastError) : null,
      ]),
    ]),
  );

  renderToolbar();
  if (subscriptionId) {
    alive = true;
    setStatus('已连接', 'ok');
    void poll();
  }

  return {
    destroy(): void {
      destroyed = true;
      stopTimer();
      if (subscriptionId) void actions.stop(subscriptionId).catch(() => undefined);
    },
  };
}
