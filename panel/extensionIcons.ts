/**
 * Inline fallback icons for guests that declare a Lucide/Remixicon name instead
 * of shipping a file. The host SDK only bundles a handful of its own icons, so
 * the panel keeps a small local set that matches the names used by the catalog.
 */

const ICON_PATHS: Record<string, string[]> = {
  'bank-card': [
    'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    'M3 10h18',
  ],
  team: [
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    'M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1',
    'M16 4.5a4 4 0 0 1 0 7',
    'M18 14a6 6 0 0 1 4 5.7V21',
  ],
  'bar-chart-2': ['M18 20V10', 'M12 20V4', 'M6 20v-6'],
  'pie-chart': ['M21.2 15.9A10 10 0 1 1 8.1 2.8', 'M22 12A10 10 0 0 0 12 2v10Z'],
  'speed-up-line': [
    'M12 21a9 9 0 1 1 9-9',
    'M12 12l4.5-4.5',
    'M12 12a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  ],
  'checkbox-circle': [
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
    'm8.5 12 2.5 2.5 5-5',
  ],
  artboard: [
    'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    'M3 9h18',
    'M9 21V9',
  ],
  folder: [
    'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  ],
  computer: [
    'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    'M8 21h8',
    'M12 17v4',
  ],
  'quill-pen': [
    'M20 3.5a2.1 2.1 0 0 0-3 0L8 12.5 6.5 17l4.5-1.5 9-9a2.1 2.1 0 0 0 0-3Z',
    'M4 20l5-5',
  ],
  'git-branch': [
    'M6 3v12',
    'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M18 9a9 9 0 0 1-9 9',
  ],
  task: [
    'M9 11l3 3L22 4',
    'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  ],
  brain: [
    'M12 4.5a2.5 2.5 0 0 0-5 0 2.5 2.5 0 0 0-2 4 3 3 0 0 0 .3 5.6A2.5 2.5 0 0 0 8 19.5a2.5 2.5 0 0 0 4 2Z',
    'M12 4.5a2.5 2.5 0 0 1 5 0 2.5 2.5 0 0 1 2 4 3 3 0 0 1-.3 5.6A2.5 2.5 0 0 1 16 19.5a2.5 2.5 0 0 1-4 2Z',
    'M12 4.5v17',
  ],
  'list-check-2': [
    'M3 5h6',
    'M3 12h6',
    'M3 19h6',
    'm16 5 2 2 4-4',
    'm16 12 2 2 4-4',
    'm16 19 2 2 4-4',
  ],
  apps: ['M4 4h6v6H4Z', 'M14 4h6v6h-6Z', 'M14 14h6v6h-6Z', 'M4 14h6v6H4Z'],
  share: [
    'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'm8.6 13.5 6.8 4',
    'm15.4 6.5-6.8 4',
  ],
  pulse: ['M22 12h-4l-3 9L9 3l-3 9H2'],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build an inline stroke icon for a known icon name, or null. */
export const createGuestIcon = (name: string | undefined): SVGSVGElement | null => {
  const key = name?.trim();
  if (!key) return null;
  const paths = ICON_PATHS[key];
  if (!paths) return null;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'guest-icon-svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  for (const definition of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', definition);
    svg.append(path);
  }
  return svg;
};
