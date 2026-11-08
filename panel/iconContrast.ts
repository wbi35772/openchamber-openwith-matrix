/**
 * Extension logos are shipped as small SVG data URLs. Some use
 * `fill="currentColor"` or a hard-coded black stroke, and inside an <img> the
 * former resolves to black. On a dark icon tile those glyphs disappear, so
 * measure the decoded image and give only the low-contrast ones a backdrop
 * that matches their own luminance.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

const parseRgb = (value: string): Rgb | null => {
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

const contrast = (a: number, b: number): number => {
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
};

interface Composite {
  color: Rgb;
  alpha: number;
}

const over = (top: Rgb, bottom: Composite): Composite => {
  const alpha = top.a + bottom.alpha * (1 - top.a);
  if (alpha <= 0) return { color: { r: 0, g: 0, b: 0, a: 1 }, alpha: 0 };
  const blend = (first: number, second: number): number =>
    (first * top.a + second * bottom.alpha * (1 - top.a)) / alpha;
  return {
    color: {
      r: blend(top.r, bottom.color.r),
      g: blend(top.g, bottom.color.g),
      b: blend(top.b, bottom.color.b),
      a: 1,
    },
    alpha,
  };
};

/** The host selection colour is often translucent, so the icon tile's computed
 * background is not what the eye sees. Walk ancestors and composite layers. */
const effectiveBackground = (element: HTMLElement): Rgb | null => {
  const layers: Rgb[] = [];
  let node: HTMLElement | null = element;
  while (node) {
    const layer = parseRgb(getComputedStyle(node).backgroundColor);
    if (layer && layer.a > 0) layers.push(layer);
    node = node.parentElement;
  }
  if (layers.length === 0) return null;
  let stacked: Composite = { color: { r: 0, g: 0, b: 0, a: 1 }, alpha: 0 };
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    stacked = over(layers[index], stacked);
  }
  if (stacked.alpha <= 0) return null;
  return stacked.color;
};

const sample = (img: HTMLImageElement): number | null => {
  const width = img.naturalWidth || 32;
  const height = img.naturalHeight || 32;
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(img, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    let weighted = 0;
    let alphaSum = 0;
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3] / 255;
      if (alpha < 0.16) continue;
      weighted +=
        (0.2126 * channel(data[index]) +
          0.7152 * channel(data[index + 1]) +
          0.0722 * channel(data[index + 2])) *
        alpha;
      alphaSum += alpha;
    }
    return alphaSum > 0 ? weighted / alphaSum : null;
  } catch {
    return null;
  }
};

const mark = (img: HTMLImageElement): void => {
  const tile = img.parentElement;
  if (!tile) return;
  const iconLum = sample(img);
  if (iconLum === null) return;
  const tileColor = effectiveBackground(tile);
  if (!tileColor) return;
  const ratio = contrast(iconLum, luminance(tileColor));
  const onLight = ratio < 2.4 && iconLum < 0.5;
  const onDark = ratio < 2.4 && iconLum >= 0.5;
  tile.classList.toggle('guest-icon-on-light', onLight);
  tile.classList.toggle('guest-icon-on-dark', onDark);
};

const tracked = new Set<HTMLImageElement>();
let watching = false;

const rescan = (): void => {
  for (const img of tracked) {
    if (!img.isConnected) {
      tracked.delete(img);
      continue;
    }
    mark(img);
  }
};

const watchTheme = (): void => {
  if (watching) return;
  watching = true;
  const observer = new MutationObserver(() => {
    queueMicrotask(rescan);
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'data-oc-theme'],
  });
};

const scheduleMark = (img: HTMLImageElement, attempts = 4): void => {
  requestAnimationFrame(() => {
    if (!img.isConnected) {
      if (attempts > 0) scheduleMark(img, attempts - 1);
      return;
    }
    mark(img);
  });
};

export const ensureIconContrast = (img: HTMLImageElement): void => {
  tracked.add(img);
  watchTheme();
  scheduleMark(img);
  if (img.complete && img.naturalWidth > 0) {
    mark(img);
    return;
  }
  img.addEventListener(
    'load',
    () => {
      mark(img);
      scheduleMark(img);
    },
    { once: true },
  );
};
