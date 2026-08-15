# dsh-json-flat-plugin

> 本插件属于 [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) 合集，完整的自研插件索引见该仓库。

Persistent DeepSeek Harness bundle wrapping the `jstool.py` JSON flat view /
edit tool as model-facing Cordis tools. Plain-JS reimplementation of the
`json-flat-tool` skill (flat view, schema inference, search, and path-based
editing), so the agent can inspect and modify JSON directly instead of shelling
out to a Python script.

## What it provides

| Tool | What it does |
|------|--------------|
| `json_flat_view` | Flatten a JSON value into `path / type / value` rows. Supports schema mode (collapse `[N]→[*]`, dedupe, hide values), a `filter` path (element-aware), and row/element-level pagination (`limit` / `offset` / `elemOffset` / `elemLimit`). |
| `json_flat_schema` | Infer a JSON Schema Draft-7 structure (array sampling up to 20 items, `required` = non-empty fields). |
| `json_flat_find` | Search flattened paths and/or values by regex (default) or glob (`*` matches any string), case-insensitive optionally. |
| `json_flat_edit` | Path-based editing: `set` / `del` / `set-null` / `before` / `after` / `copy` / `merge`. Defaults to a dry-run preview with a compact per-path diff; pass `apply: true` to write back through the `fs` service. |

## Inputs

- **read-only tools** accept `source` (inline JSON text or `@file`) and/or
  `file` (a path resolved through the `fs` service). Inline JSON works even
  without `fs`.
- **`json_flat_edit`** requires the `fs` service and always works on `file`.
  A dry-run returns `changes` but never writes; `apply: true` atomically writes
  the result back.

## Path syntax

```
count             root-level key
users[0]          array element
users[0].name     nested key
root[0].key       root-array element key
root              the root node itself
```

## Design notes

- Pure algorithmics live in `json-flat-core.js` (deterministic, no runtime
  dependencies) so they can be unit-tested standalone and reused without the
  DSH runtime.
- Mutating edits capture a deep clone before applying so the returned diff
  compares against the pre-mutation state (the `apply*` helpers mutate in
  place).
- The Loader entry (`index.js`) is failure-isolated: the optional `fs` service
  and all heavy imports are resolved inside `apply()`, so a missing service or
  a load error degrades to a diagnostic instead of taking down the profile.
- Read-only tools never write; editing is `apply: true`-opt-in so accidental
  mutation is avoided.

## Development

```bash
node --test test.mjs   # core algorithmics
node smoke.mjs         # tool registration + end-to-end via mock ctx + fs
```
