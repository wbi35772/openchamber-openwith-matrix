/**
 * Kubernetes resource group.
 *
 * Contexts and pods come from the user's kubeconfig; port-forwards are child
 * processes owned by this service. A forward is only reported as running while
 * its kubectl process is alive, so a crashed tunnel never looks healthy.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import type {
  K8sContextInfo,
  K8sPod,
  K8sSettings,
  K8sSnapshot,
  PortForwardStatus,
} from '../shared/types.ts';
import { killTree, runCapture } from './processUtils.ts';

const QUERY_TIMEOUT_MS = 12_000;

interface RawContext {
  name?: string;
  context?: { cluster?: string; user?: string; namespace?: string };
}

interface RawPod {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string };
  status?: {
    phase?: string;
    containerStatuses?: Array<{ ready?: boolean; restartCount?: number }>;
  };
}

const ageFrom = (timestamp: string | undefined): string => {
  if (!timestamp) return '-';
  const started = Date.parse(timestamp);
  if (Number.isNaN(started)) return '-';
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

const toPod = (pod: RawPod, context: string): K8sPod => {
  const containers = pod.status?.containerStatuses ?? [];
  const ready = containers.filter((container) => container.ready === true).length;
  const restarts = containers.reduce((total, container) => total + (container.restartCount ?? 0), 0);
  return {
    name: pod.metadata?.name ?? '',
    namespace: pod.metadata?.namespace ?? '',
    context,
    status: pod.status?.phase ?? 'Unknown',
    ready: `${ready}/${containers.length}`,
    restarts: String(restarts),
    age: ageFrom(pod.metadata?.creationTimestamp),
  };
};

export class K8sController {
  private readonly forwards = new Map<
    string,
    { child: ChildProcess; info: PortForwardStatus; stderr: string }
  >();

  async snapshot(settings: K8sSettings): Promise<K8sSnapshot> {
    const version = await runCapture('kubectl', ['version', '--client', '-o', 'json'], {
      timeoutMs: 6000,
      maxBytes: 64 * 1024,
    });
    if (version.code !== 0) {
      return {
        available: false,
        contexts: [],
        pods: [],
        forwards: this.forwardList(),
        error: (version.stderr || version.error || 'kubectl-unavailable').trim(),
      };
    }

    const config = await runCapture('kubectl', ['config', 'view', '-o', 'json'], {
      timeoutMs: 8000,
      maxBytes: 2 * 1024 * 1024,
    });
    let currentContext = settings.defaultContext;
    let contexts: K8sContextInfo[] = [];
    if (config.code === 0) {
      try {
        const parsed = JSON.parse(config.stdout) as {
          contexts?: RawContext[];
          'current-context'?: string;
        };
        currentContext = parsed['current-context'] || currentContext;
        contexts = (parsed.contexts ?? []).map((entry) => ({
          name: entry.name ?? '',
          cluster: entry.context?.cluster ?? '',
          user: entry.context?.user ?? '',
          namespace: entry.context?.namespace ?? settings.defaultNamespace,
          current: (entry.name ?? '') === currentContext,
        }));
      } catch {
        /* malformed kubeconfig: keep empty list */
      }
    }

    const pods: K8sPod[] = [];
    let error: string | undefined;
    const activeContext = currentContext || contexts[0]?.name || '';
    const podArgs = ['get', 'pods', '-A'];
    if (activeContext) podArgs.push('--context', activeContext);
    podArgs.push('-o', 'json');
    const podResult = await runCapture('kubectl', podArgs, {
      timeoutMs: QUERY_TIMEOUT_MS,
      maxBytes: 6 * 1024 * 1024,
    });
    if (podResult.code === 0) {
      try {
        const parsed = JSON.parse(podResult.stdout) as { items?: RawPod[] };
        for (const item of parsed.items ?? []) pods.push(toPod(item, activeContext));
      } catch {
        error = 'kubectl returned malformed JSON';
      }
    } else {
      error = (podResult.stderr || podResult.error || 'kubectl-get-pods-failed').trim();
    }

    return {
      available: true,
      contexts,
      pods,
      forwards: this.forwardList(),
      ...(error ? { error } : {}),
    };
  }

  async startForward(config: {
    context: string;
    namespace: string;
    pod: string;
    localPort: number;
    remotePort: number;
  }): Promise<PortForwardStatus> {
    const id = `${config.context}:${config.namespace}:${config.pod}:${config.localPort}`;
    const existing = this.forwards.get(id);
    if (existing && existing.child.exitCode === null) return existing.info;

    for (const entry of this.forwards.values()) {
      if (entry.info.localPort === config.localPort && entry.child.exitCode === null) {
        return {
          id,
          ...config,
          running: false,
          error: `local port ${config.localPort} is already forwarded`,
        };
      }
    }

    const child = spawn(
      'kubectl',
      [
        '--context',
        config.context,
        '--namespace',
        config.namespace,
        'port-forward',
        `pod/${config.pod}`,
        `${config.localPort}:${config.remotePort}`,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const info: PortForwardStatus = {
      id,
      ...config,
      running: true,
      ...(child.pid ? { pid: child.pid } : {}),
    };
    const entry = { child, info, stderr: '' };
    this.forwards.set(id, entry);

    child.stderr?.on('data', (chunk: Buffer) => {
      entry.stderr = `${entry.stderr}${chunk.toString('utf8')}`.slice(-4000);
    });
    child.on('exit', () => {
      info.running = false;
      if (entry.stderr.trim()) info.error = entry.stderr.trim().slice(-600);
    });
    child.on('error', (error) => {
      info.running = false;
      info.error = error.message;
    });

    await new Promise((resolve) => setTimeout(resolve, 900));
    if (child.exitCode !== null) {
      info.running = false;
      info.error = entry.stderr.trim() || `kubectl exited with ${child.exitCode}`;
    }
    return info;
  }

  async stopForward(id: string): Promise<boolean> {
    const entry = this.forwards.get(id);
    if (!entry) return false;
    await killTree(entry.child);
    entry.info.running = false;
    this.forwards.delete(id);
    return true;
  }

  async stopAll(): Promise<void> {
    const children = [...this.forwards.values()].map((entry) => entry.child);
    this.forwards.clear();
    await Promise.all(children.map((child) => killTree(child)));
  }

  private forwardList(): PortForwardStatus[] {
    return [...this.forwards.values()].map((entry) => ({ ...entry.info }));
  }
}
