/**
 * Presentation metadata for installed guests.
 *
 * Category definitions and guest assignments live in the matrix config, so the
 * defaults are editable from the panel or the JSON config modal. Resolution
 * below stays defensive: an unknown category id falls back to the last
 * configured category, so a newly installed guest never disappears.
 */

import {
  DEFAULT_EXTENSION_ASSIGNMENTS,
  DEFAULT_EXTENSION_CATEGORIES,
  type ExtensionCategoryConfig,
  type GuestSummary,
  type MatrixConfig,
} from '../shared/types.ts';

export const ALL_CATEGORIES = '全部';

export interface GuestLibrary {
  categories: ExtensionCategoryConfig[];
  assignments: Record<string, string>;
}

export const libraryOf = (config: MatrixConfig | null | undefined): GuestLibrary => {
  const raw = config?.extensionLibrary;
  const categories =
    raw && Array.isArray(raw.categories) && raw.categories.length
      ? raw.categories.map((category) => ({ id: category.id, name: category.name }))
      : DEFAULT_EXTENSION_CATEGORIES.map((category) => ({ ...category }));
  const known = new Set(categories.map((category) => category.id));
  const assignments: Record<string, string> = { ...DEFAULT_EXTENSION_ASSIGNMENTS };
  for (const [guestId, categoryId] of Object.entries(raw?.assignments ?? {})) {
    if (typeof categoryId === 'string' && known.has(categoryId)) assignments[guestId] = categoryId;
  }
  for (const guestId of Object.keys(assignments)) {
    if (!known.has(assignments[guestId])) delete assignments[guestId];
  }
  return { categories, assignments };
};

export const fallbackCategoryId = (library: GuestLibrary): string => {
  const other = library.categories.find((category) => category.id === 'other');
  return other?.id ?? library.categories[library.categories.length - 1]?.id ?? 'other';
};

export const categoryIdOf = (guest: GuestSummary, library: GuestLibrary): string =>
  library.assignments[guest.id] ?? fallbackCategoryId(library);

export const categoryNameOf = (guest: GuestSummary, library: GuestLibrary): string => {
  const id = categoryIdOf(guest, library);
  return library.categories.find((category) => category.id === id)?.name ?? '其他';
};

export const categoryClass = (index: number): string => `cat-${index % 8}`;

export interface GuestNote {
  label: string;
  tone: 'warn' | 'info';
  title: string;
}

const NOTES_BY_ID: Record<string, GuestNote> = {
  openwith: {
    label: '二次开发',
    tone: 'warn',
    title: '本项目：基于上游 OpenWith Matrix 的二次开发版本',
  },
  canvas: {
    label: '本地修改',
    tone: 'warn',
    title: '工作区存在未提交的本地修改',
  },
  'context-inspector': {
    label: '本地修改',
    tone: 'warn',
    title: '工作区存在未提交的本地修改',
  },
};

const normalizeRepo = (value: string): string =>
  value
    .trim()
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase();

/** Notes shown on the row: curated local notes plus an automatic fork check. */
export const guestNotes = (guest: GuestSummary): GuestNote[] => {
  const notes: GuestNote[] = [];
  const curated = NOTES_BY_ID[guest.id];
  if (curated) notes.push(curated);
  if (
    guest.repoUrl &&
    guest.originUrl &&
    /^https?:/i.test(guest.repoUrl) &&
    /^https?:/i.test(guest.originUrl) &&
    normalizeRepo(guest.repoUrl) !== normalizeRepo(guest.originUrl)
  ) {
    notes.push({
      label: '二次开发',
      tone: 'warn',
      title: '安装源与 package.json 中的上游仓库不一致',
    });
  }
  return notes;
};

export const isSecondDev = (guest: GuestSummary): boolean =>
  guestNotes(guest).some((note) => note.label === '二次开发');

export const isUpdateAvailable = (guest: GuestSummary): boolean =>
  Boolean(guest.latestVersion && guest.version && guest.latestVersion !== guest.version);

export const updateSource = (guest: GuestSummary): string =>
  guest.originUrl?.trim() || guest.repoUrl?.trim() || '';
