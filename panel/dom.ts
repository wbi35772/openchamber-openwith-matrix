/**
 * Minimal DOM builder for the panel. The panel runs as a sandboxed IIFE with no
 * framework, so every view composes plain elements through these helpers.
 */

export type Child = Node | string | number | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  style?: Partial<CSSStyleDeclaration>;
  on?: Partial<{
    [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void;
  }>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  if (props.style) Object.assign(node.style, props.style);
  for (const [name, handler] of Object.entries(props.on ?? {})) {
    node.addEventListener(name, handler as EventListener);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function button(
  label: string,
  onClick: () => void,
  options: { class?: string; title?: string; disabled?: boolean; variant?: 'primary' | 'ghost' | 'danger' } = {},
): HTMLButtonElement {
  const variant = options.variant ?? 'ghost';
  return h(
    'button',
    {
      class: `btn ${variant}${options.class ? ` ${options.class}` : ''}`,
      text: label,
      attrs: { type: 'button', title: options.title, disabled: options.disabled },
      on: { click: onClick },
    },
  );
}

export function badge(text: string, tone: 'ok' | 'warn' | 'error' | 'muted' | 'info' = 'muted'): HTMLSpanElement {
  return h('span', { class: `badge ${tone}`, text });
}

export function section(
  title: string,
  subtitle: string | null,
  body: Child[],
  actions: Child[] = [],
): HTMLElement {
  return h('section', { class: 'card' }, [
    h('header', { class: 'card-head' }, [
      h('div', { class: 'card-titles' }, [
        h('h2', { text: title }),
        subtitle ? h('p', { class: 'card-subtitle', text: subtitle }) : null,
      ]),
      actions.length ? h('div', { class: 'card-actions' }, actions) : null,
    ]),
    h('div', { class: 'card-body' }, body),
  ]);
}

export function field(label: string, control: Node): HTMLElement {
  return h('label', { class: 'field' }, [h('span', { class: 'field-label', text: label }), control]);
}

export function empty(text: string): HTMLElement {
  return h('p', { class: 'empty', text });
}

export function errorText(text: string): HTMLElement {
  return h('p', { class: 'error-text', text });
}

export function timeAgo(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s 前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m 前`;
  return `${Math.round(minutes / 60)}h 前`;
}

/**
 * Show a small floating card while the pointer rests on `target`.
 *
 * The card is appended to `document.body` with `position: fixed`, so it is not
 * clipped by a pane's `overflow: hidden`. The content builder runs only when
 * the pointer actually rests, which keeps long lists cheap.
 */
export function tooltip(target: HTMLElement, content: () => Child | Child[]): void {
  let timer: number | null = null;
  let card: HTMLElement | null = null;

  const hide = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    card?.remove();
    card = null;
  };

  const show = (): void => {
    timer = null;
    const data = content();
    const children = Array.isArray(data) ? data : [data];
    card = h('div', { class: 'hover-tip' }, children);
    document.body.append(card);
    const rect = target.getBoundingClientRect();
    const tip = card.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + tip.width > window.innerWidth - 8) left = window.innerWidth - tip.width - 8;
    if (top + tip.height > window.innerHeight - 8) top = rect.top - tip.height - 6;
    card.style.left = `${Math.max(8, left)}px`;
    card.style.top = `${Math.max(8, top)}px`;
  };

  target.addEventListener('mouseenter', () => {
    hide();
    timer = window.setTimeout(show, 260);
  });
  target.addEventListener('mouseleave', hide);
  target.addEventListener('mousedown', hide);
  target.addEventListener('blur', hide);
}
