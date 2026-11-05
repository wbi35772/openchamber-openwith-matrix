/**
 * WSL2 resource group.
 *
 * Distros come from `wsl -l -v`, the address from `hostname -I`, and port
 * health from a plain TCP connect to localhost (WSL2 forwards listening ports
 * there). Nothing is started or stopped here: the group is a dashboard for the
 * services the user already runs.
 */

import net from 'node:net';

import type { WslDistro, WslPortConfig, WslPortStatus, WslSettings, WslSnapshot } from '../shared/types.ts';
import { runCapture } from './processUtils.ts';

const clean = (text: string): string => text.replace(/\u0000/g, '').replace(/^\uFEFF/, '');

const probePort = (port: number, timeoutMs = 1200): Promise<{ open: boolean; latencyMs?: number }> =>
  new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ open, ...(open ? { latencyMs: Date.now() - started } : {}) });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });

const parseDistros = (stdout: string): WslDistro[] => {
  const lines = clean(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const distros: WslDistro[] = [];
  for (const line of lines) {
    if (/^NAME\s+STATE\s+VERSION/i.test(line)) continue;
    const defaultDistro = line.startsWith('*');
    const body = defaultDistro ? line.slice(1).trim() : line;
    const parts = body.split(/\s{2,}|\t+/).filter(Boolean);
    if (parts.length < 2) continue;
    distros.push({
      name: parts[0] ?? '',
      state: parts[1] ?? '',
      version: parts[2] ?? '',
      default: defaultDistro,
    });
  }
  return distros;
};

export class WslController {
  async snapshot(settings: WslSettings, ports: WslPortConfig[]): Promise<WslSnapshot> {
    const listed = await runCapture('wsl.exe', ['-l', '-v'], {
      timeoutMs: 8000,
      maxBytes: 256 * 1024,
    });
    if (listed.code !== 0) {
      return {
        available: false,
        distros: [],
        ports: ports.map((port) => ({
          id: port.id,
          label: port.label,
          port: port.port,
          protocol: port.protocol,
          open: false,
        })),
        error: (clean(listed.stderr || listed.stdout) || listed.error || 'wsl-unavailable').trim(),
      };
    }

    const distros = parseDistros(listed.stdout);
    const distro =
      settings.distro || distros.find((entry) => entry.default)?.name || distros[0]?.name || '';
    let ip: string | undefined;
    if (distro) {
      const address = await runCapture('wsl.exe', ['-d', distro, '--', 'hostname', '-I'], {
        timeoutMs: 8000,
        maxBytes: 8192,
      });
      if (address.code === 0) {
        ip = clean(address.stdout).trim().split(/\s+/)[0] || undefined;
      }
    }

    const statuses: WslPortStatus[] = [];
    for (const port of ports) {
      const probe = await probePort(port.port);
      const url =
        port.protocol === 'tcp'
          ? undefined
          : `${port.protocol}://localhost:${port.port}${port.path ?? '/'}`;
      statuses.push({
        id: port.id,
        label: port.label,
        port: port.port,
        protocol: port.protocol,
        open: probe.open,
        ...(probe.latencyMs !== undefined ? { latencyMs: probe.latencyMs } : {}),
        ...(url ? { url } : {}),
      });
    }

    return {
      available: true,
      distros,
      ...(ip ? { ip } : {}),
      ports: statuses,
    };
  }
}
