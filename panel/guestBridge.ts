/**
 * Host-protocol shim for a guest extension embedded inside a Matrix tab.
 *
 * A guest panel normally talks to the OpenChamber host through
 * `window.parent`. Here its parent is our panel, not the host, so the shim
 * answers the same wire protocol and forwards every privileged call to the
 * real host through the Matrix service. The nested guest keeps its own CSP and
 * opaque origin; only structured messages cross the boundary.
 */

import type { HostClient, HostReadyContext } from '@openchamber/sdk';
import type { GuestServiceRequest, GuestServiceResult } from '../shared/types.ts';

const CHANNEL = 'openchamber.sdk';
const VERSION = 1;

interface GuestCall {
  channel?: unknown;
  v?: unknown;
  type?: unknown;
  id?: unknown;
  payload?: unknown;
}

export interface GuestBridgeOptions {
  frame: HTMLIFrameElement;
  ready: () => HostReadyContext | null;
  host: HostClient;
  serviceRequest: (request: GuestServiceRequest) => Promise<GuestServiceResult>;
  storage: (request: unknown) => Promise<unknown>;
  close: () => void;
  onStatus?: (text: string) => void;
}

export interface GuestBridge {
  sendReady(): void;
  dispose(): void;
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

export function createGuestBridge(options: GuestBridgeOptions): GuestBridge {
  let disposed = false;

  const post = (message: unknown): void => {
    if (disposed) return;
    const target = options.frame.contentWindow;
    if (!target) return;
    target.postMessage(message, '*');
  };

  const readyContext = (): HostReadyContext | null => {
    const base = options.ready();
    if (!base) return null;
    return {
      theme: base.theme,
      locale: base.locale,
      directory: base.directory,
      session: base.session,
      surface: 'panel',
      connection: base.connection,
      settings: {},
      item: null,
    };
  };

  const sendReady = (): void => {
    const context = readyContext();
    if (!context) return;
    post({ channel: CHANNEL, v: VERSION, type: 'ready', payload: context });
    options.onStatus?.('已连接宿主桥');
  };

  const reply = (id: unknown, payload: unknown): void => {
    if (typeof id !== 'string' || !id) return;
    post({ channel: CHANNEL, v: VERSION, type: 'result', id, ok: true, payload });
  };

  const fail = (id: unknown, code: string, error: string): void => {
    if (typeof id !== 'string' || !id) return;
    post({ channel: CHANNEL, v: VERSION, type: 'result', id, ok: false, code, error });
  };

  const handle = async (message: GuestCall): Promise<void> => {
    const type = asString(message.type);
    const id = message.id;
    const payload = message.payload;
    try {
      switch (type) {
        case 'hello':
          sendReady();
          return;
        case 'service-request': {
          reply(id, await options.serviceRequest(payload as GuestServiceRequest));
          return;
        }
        case 'storage': {
          reply(id, await options.storage(payload));
          return;
        }
        case 'toast':
          await options.host.toast(payload as Parameters<HostClient['toast']>[0]);
          reply(id, undefined);
          return;
        case 'open-url': {
          const url = asString((payload as { url?: unknown } | null)?.url);
          if (!url) throw new Error('missing url');
          await options.host.openUrl(url);
          reply(id, undefined);
          return;
        }
        case 'clipboard-write': {
          const text = asString((payload as { text?: unknown } | null)?.text);
          await options.host.writeClipboard(text);
          reply(id, undefined);
          return;
        }
        case 'compose':
          await options.host.compose(payload as Parameters<HostClient['compose']>[0]);
          reply(id, undefined);
          return;
        case 'prompt':
          reply(id, await options.host.prompt(payload as Parameters<HostClient['prompt']>[0]));
          return;
        case 'start-session':
          reply(
            id,
            await options.host.startSession(payload as Parameters<HostClient['startSession']>[0]),
          );
          return;
        case 'open-session': {
          const sessionId = asString((payload as { sessionId?: unknown } | null)?.sessionId);
          if (!sessionId) throw new Error('missing sessionId');
          await options.host.openSession(sessionId);
          reply(id, undefined);
          return;
        }
        case 'file-read':
        case 'file-list':
        case 'file-stat': {
          const path = asString((payload as { path?: unknown } | null)?.path);
          if (!path) throw new Error('missing path');
          if (type === 'file-read') reply(id, await options.host.readFile(path));
          else if (type === 'file-list') reply(id, await options.host.listDir(path));
          else reply(id, await options.host.stat(path));
          return;
        }
        case 'file-write': {
          const body = payload as { path?: unknown; content?: unknown } | null;
          reply(id, await options.host.writeFile(asString(body?.path), asString(body?.content)));
          return;
        }
        case 'badge': {
          const count = (payload as { count?: unknown } | null)?.count;
          await options.host.setBadge(typeof count === 'number' ? count : null);
          reply(id, undefined);
          return;
        }
        case 'resize':
        case 'status-controls':
        case 'popover-open':
        case 'popover-close':
        case 'popover-anchor':
        case 'workspace-unsubscribe':
        case 'shells-unsubscribe':
          reply(id, undefined);
          return;
        case 'close':
          reply(id, undefined);
          window.setTimeout(options.close, 40);
          return;
        default:
          fail(id, 'UNSUPPORTED', `嵌入的扩展调用了尚未桥接的宿主能力：${type || 'unknown'}`);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      fail(id, 'SERVICE_FAILED', text);
    }
  };

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return;
    if (event.source !== options.frame.contentWindow) return;
    const data = event.data as GuestCall | null;
    if (!data || typeof data !== 'object') return;
    if (data.channel !== CHANNEL) return;
    if (data.v !== VERSION) return;
    void handle(data);
  };

  const onLoad = (): void => {
    sendReady();
  };

  window.addEventListener('message', onMessage);
  options.frame.addEventListener('load', onLoad);

  return {
    sendReady,
    dispose(): void {
      disposed = true;
      window.removeEventListener('message', onMessage);
      options.frame.removeEventListener('load', onLoad);
    },
  };
}
