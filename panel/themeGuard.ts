/**
 * Keep the panel readable when a host theme snapshot carries a foreground that
 * is missing, transparent, or too close to the background. OpenChamber passes
 * theme tokens through CSS variables, so a bad token used to make body text
 * black on a black surface.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Palette {
  bg: string;
  elevated: string;
  fg: string;
  muted: string;
  subtle: string;
  border: string;
  hover: string;
  selection: string;
  primary: string;
  primaryFg: string;
}

const DARK: Palette = {
  bg: '#111318',
  elevated: '#191c22',
  fg: '#e6e8ee',
  muted: '#9aa1ad',
  subtle: '#8a919e',
  border: '#2a2f3a',
  hover: '#232833',
  selection: '#2d3442',
  primary: '#6d8cff',
  primaryFg: '#0b1020',
};

const LIGHT: Palette = {
  bg: '#f7f7f9',
  elevated: '#ffffff',
  fg: '#1b1c22',
  muted: '#5d6370',
  subtle: '#666c78',
  border: '#d8dbe2',
  hover: '#eceef3',
  selection: '#e1e5ed',
  primary: '#5b5bd6',
  primaryFg: '#ffffff',
};

const TOKENS = [
  '--oc-bg',
  '--oc-elevated',
  '--oc-fg',
  '--oc-muted',
  '--oc-subtle',
  '--oc-hover',
  '--oc-selection',
  '--oc-primary',
  '--oc-primary-fg',
] as const;

type TokenName = (typeof TOKENS)[number];

const parseRgb = (value: string): Rgb | null => {
  const hex = value.trim().match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const digits = hex[1];
    const expand = (part: string): number => parseInt(part.length === 1 ? part + part : part, 16);
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits[0]),
        g: expand(digits[1]),
        b: expand(digits[2]),
        a: digits.length === 4 ? expand(digits[3]) / 255 : 1,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: expand(digits.slice(0, 2)),
        g: expand(digits.slice(2, 4)),
        b: expand(digits.slice(4, 6)),
        a: digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1,
      };
    }
    return null;
  }
  const match = value.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i,
  );
  if (!match) return null;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
};

const channel = (value: number): number => {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
};

const luminance = (color: Rgb): number =>
  0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);

const contrast = (a: Rgb, b: Rgb): number => {
  const first = luminance(a);
  const second = luminance(b);
  const light = Math.max(first, second);
  const dark = Math.min(first, second);
  return (light + 0.05) / (dark + 0.05);
};

const isDarkBackground = (color: Rgb): boolean => luminance(color) < 0.32;

const blendOver = (top: Rgb, bottom: Rgb): Rgb => {
  if (top.a >= 0.999) return top;
  const alpha = Math.max(0, Math.min(1, top.a));
  return {
    r: top.r * alpha + bottom.r * (1 - alpha),
    g: top.g * alpha + bottom.g * (1 - alpha),
    b: top.b * alpha + bottom.b * (1 - alpha),
    a: 1,
  };
};

/** Resolve every theme token through a probe so named, hsl, oklch and rgb
 * values all come back as comparable rgb. Missing tokens fall back to the
 * local palette and therefore never resolve to the browser's black default. */
const readTokens = (root: HTMLElement, palette: Palette): Record<TokenName, Rgb> => {
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;visibility:hidden;pointer-events:none;';
  root.append(probe);
  const values = {} as Record<TokenName, Rgb>;
  const fallbacks: Record<TokenName, string> = {
    '--oc-bg': palette.bg,
    '--oc-elevated': palette.elevated,
    '--oc-fg': palette.fg,
    '--oc-muted': palette.muted,
    '--oc-subtle': palette.subtle,
    '--oc-hover': palette.hover,
    '--oc-selection': palette.selection,
    '--oc-primary': palette.primary,
    '--oc-primary-fg': palette.primaryFg,
  };
  for (const name of TOKENS) {
    probe.style.color = '';
    probe.style.color = `var(${name}, ${fallbacks[name]})`;
    values[name] = parseRgb(getComputedStyle(probe).color) ?? { r: 0, g: 0, b: 0, a: 1 };
  }
  probe.remove();
  return values;
};

const setToken = (root: HTMLElement, name: TokenName, value: string): void => {
  root.style.setProperty(name, value);
};

/**
 * Probe the resolved host tokens and repair only the pairs that are unusable.
 * Valid host colours stay intact, so a deliberate theme still looks deliberate.
 */
export const ensureReadableTheme = (root: HTMLElement): void => {
  const mode = root.dataset.ocTheme === 'light' ? LIGHT : DARK;
  const tokens = readTokens(root, mode);
  const bg = tokens['--oc-bg'];
  const elevated = tokens['--oc-elevated'];
  const opaqueBg = bg.a >= 0.5;
  const dark = opaqueBg ? isDarkBackground(bg) : mode === DARK;
  const palette = dark ? DARK : LIGHT;

  if (!opaqueBg) {
    setToken(root, '--oc-bg', palette.bg);
    setToken(root, '--oc-elevated', palette.elevated);
  }

  const background = opaqueBg ? bg : parseRgb(palette.bg) ?? { r: 0, g: 0, b: 0, a: 1 };
  const elevatedBg =
    opaqueBg && elevated.a >= 0.5 ? elevated : parseRgb(palette.elevated) ?? { r: 0, g: 0, b: 0, a: 1 };

  const readableText = (color: Rgb, against: Rgb, minimum: number): boolean =>
    contrast(blendOver(color, against), against) >= minimum;

  const readableOn = (color: Rgb, surface: Rgb, minimum: number): boolean => {
    const flat = blendOver(surface, background);
    return contrast(blendOver(color, flat), flat) >= minimum;
  };

  let fg = tokens['--oc-fg'];
  if (!readableText(fg, background, 3) || !readableText(fg, elevatedBg, 3)) {
    fg = parseRgb(palette.fg) ?? { r: 230, g: 232, b: 238, a: 1 };
    setToken(root, '--oc-fg', palette.fg);
  }
  const fgShown = blendOver(fg, background);

  const muted = tokens['--oc-muted'];
  if (!readableText(muted, background, 2.6) || !readableText(muted, elevatedBg, 2.6)) {
    setToken(root, '--oc-muted', palette.muted);
  }

  const subtle = tokens['--oc-subtle'];
  if (!readableText(subtle, background, 2.3) || !readableText(subtle, elevatedBg, 2.3)) {
    setToken(root, '--oc-subtle', palette.subtle);
  }

  const hover = tokens['--oc-hover'];
  if (!readableOn(fgShown, hover, 2)) {
    setToken(root, '--oc-hover', palette.hover);
  }

  const selection = tokens['--oc-selection'];
  if (!readableOn(fgShown, selection, 2)) {
    setToken(root, '--oc-selection', palette.selection);
  }

  const primary = tokens['--oc-primary'];
  const primaryFg = tokens['--oc-primary-fg'];
  const primaryShown = blendOver(primary, background);
  if (!readableText(primaryFg, primaryShown, 2.5)) {
    setToken(root, '--oc-primary-fg', palette.primaryFg);
  }

  const wantedScheme = dark ? 'dark' : 'light';
  if (root.style.colorScheme !== wantedScheme) root.style.colorScheme = wantedScheme;
};

let watched = false;

/** Re-check after every host theme snapshot. `applyHostReady` can run more
 * than once, and the last snapshot is the one the user actually sees. */
export const watchReadableTheme = (root: HTMLElement): void => {
  ensureReadableTheme(root);
  if (watched) return;
  watched = true;
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      ensureReadableTheme(root);
    });
  });
  observer.observe(root, { attributes: true, attributeFilter: ['style', 'data-oc-theme'] });
};
