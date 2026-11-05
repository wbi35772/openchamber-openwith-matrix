# Agent Guide

Conventions for working in this repository.

## Changelog is mandatory

Every change must be recorded in [`changelog.md`](./changelog.md) as part of the
same change set. A change without a changelog entry is considered incomplete.

- One line per change, formatted `- 新增|优化|修复 YYYY-MM-DD <description>`, and
  keep the newest entry at the top. There are no version headings or sections.
- Date each entry with the day you made the change; use `新增` for features,
  `优化` for improvements and `修复` for fixes, then a short Chinese description
  of the effect the user can see.
- Skip trivial or non-functional changes: version bumps and iteration markers,
  and anything that only touches tests, fixtures or dev-only helpers.
- Keep `changelog.md` in the same commit as the code it describes.

## Always build

Run `npm run typecheck` and `npm run build` after edits; run `npm test` before a
release. `dist/` is generated and must never be committed, and sources and
`dist/` must not drift apart in an installed copy.

The bundler is `@openchamber/sdk`'s `scripts/bundle-guest.ts`, executed through
Bun. Node 20+, npm 10+ and Bun 1.3.x are required.

## Project conventions

- Product copy in `changelog.md` and the docs is Chinese; code comments and
  identifiers are English.
- `README.md` is English and `README.zh-CN.md` is its Chinese mirror — keep the
  two in sync when a shared section changes.
- `panel/` is a sandboxed browser iframe: no Node built-ins, no direct external
  network, no arbitrary web iframes. Privileged work belongs in `service/`.
- `service/` never touches the DOM; it returns data.
- Shared types live only in `shared/types.ts`.
- New external commands must be added to
  `package.json → openchamber.contributes.service.permissions.exec`.
- Keep the panel usable at a ~406 px sidebar width.

## Layout

```text
panel/            sandboxed UI, tab manager and views
service/          Node service, controllers and config store
shared/types.ts   panel/service contract
config/           shipped default configuration
docs/             baseline, architecture, configuration, development
scripts/build.mjs build pipeline
```

- `panel/main.ts` wires the shell, host requests and tab factories.
- `panel/views/` holds home, resource editor, custom groups, config and log views.
- `service/main.ts` is the HTTP route table; controllers live beside it.
- `config/default-matrix.json` is deep-merged into the user config.

## Before finishing

1. Add the changelog entry.
2. Update the affected docs under `docs/` and the README pair.
3. Run `npm run typecheck` and `npm run build`.
4. If the change affects runtime behavior, install `dist/` as a folder extension
   and follow the checklist in `docs/BASELINE.md` §5.
5. Do not commit `dist/`, `node_modules/`, logs, local config or secrets.
