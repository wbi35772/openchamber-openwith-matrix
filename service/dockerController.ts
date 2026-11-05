/**
 * Docker resource group.
 *
 * The service only shells out to the Docker CLI: no daemon socket is opened
 * directly, so the same code works with Docker Desktop, Rancher Desktop or a
 * remote DOCKER_HOST. Every call is bounded by a timeout because a stopped
 * daemon can otherwise hang for a long time.
 */

import type { DockerContainer, DockerSnapshot } from '../shared/types.ts';
import { runCapture } from './processUtils.ts';

const VERSION_TIMEOUT_MS = 6000;
const LIST_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 60_000;

const PS_FORMAT =
  '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t{{.CreatedAt}}';

const parseContainers = (stdout: string): DockerContainer[] =>
  stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [id = '', name = '', image = '', state = '', status = '', ports = '', createdAt = ''] =
        line.split('\t');
      return { id, name, image, state, status, ports, ...(createdAt ? { createdAt } : {}) };
    })
    .filter((container) => container.id.length > 0);

export class DockerController {
  async snapshot(): Promise<DockerSnapshot> {
    const version = await runCapture('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: VERSION_TIMEOUT_MS,
      maxBytes: 8192,
    });
    if (version.code !== 0) {
      return {
        available: false,
        containers: [],
        error: (version.stderr || version.stdout || version.error || 'docker-unavailable').trim(),
      };
    }
    const list = await runCapture('docker', ['ps', '-a', '--no-trunc', '--format', PS_FORMAT], {
      timeoutMs: LIST_TIMEOUT_MS,
      maxBytes: 2 * 1024 * 1024,
    });
    if (list.code !== 0) {
      return {
        available: true,
        version: version.stdout.trim(),
        containers: [],
        error: (list.stderr || list.error || 'docker-ps-failed').trim(),
      };
    }
    return {
      available: true,
      version: version.stdout.trim(),
      containers: parseContainers(list.stdout),
    };
  }

  async containerAction(
    id: string,
    action: 'start' | 'stop' | 'restart' | 'kill' | 'pause' | 'unpause',
  ): Promise<{ ok: boolean; detail: string }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) {
      return { ok: false, detail: 'invalid-container-id' };
    }
    const result = await runCapture('docker', [action, id], {
      timeoutMs: ACTION_TIMEOUT_MS,
      maxBytes: 64 * 1024,
    });
    return {
      ok: result.code === 0,
      detail: (result.code === 0 ? result.stdout : result.stderr || result.error || '').trim(),
    };
  }

  async compose(
    action: 'up' | 'down' | 'ps' | 'restart',
    files: string[],
    cwd?: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const args = ['compose'];
    for (const file of files) args.push('-f', file);
    if (action === 'up') args.push('up', '-d', '--remove-orphans');
    else if (action === 'restart') args.push('restart');
    else if (action === 'ps') args.push('ps');
    else args.push('down', '--remove-orphans');
    const result = await runCapture('docker', args, {
      timeoutMs: ACTION_TIMEOUT_MS,
      cwd,
      maxBytes: 256 * 1024,
    });
    return {
      ok: result.code === 0,
      detail: (result.code === 0 ? result.stdout : result.stderr || result.error || '').trim(),
    };
  }
}
