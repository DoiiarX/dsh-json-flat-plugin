/**
 * JSON Flat Tool implementation (persistent bundle, host composition row).
 *
 * Provides model-facing tools wrapping the jstool.py algorithmics:
 *   - json_flat_view    flat path/type/value listing (+ schema / filter / pagination)
 *   - json_flat_schema  infer JSON Schema Draft 7 for a value or file
 *   - json_flat_find    search flattened paths and/or values by regex or glob
 *   - json_flat_edit    set / del / before / after / set-null / copy / merge
 *
 * Editing tools read and write JSON through the `fs` service. Absence of the
 * `fs` service never breaks the read-only tools: they accept inline JSON or
 * plain text. Edit commands require `fs` to be present.
 *
 * For every mutating command, a dry-run preview is returned by default; pass
 * `apply: true` to write the change back. Read-only tools never write.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  flatten,
  inferNulls,
  signature,
  findRows,
  prepareView,
  buildSchema,
  parsePath,
  parseValue,
  applySet,
  applyDel,
  applyBefore,
  applyAfter,
  applySetNull,
  applyCopy,
  applyMerge,
} from './json-flat-core.js'

function safeError(error) {
  return error instanceof Error ? error.message : String(error)
}

// ── fs helpers ───────────────────────────────────────────────────────────

async function readJsonFromFs(fsSvc, filePath) {
  const target = await fsSvc.resolve(filePath)
  const info = await fsSvc.stat(target)
  if (info === undefined) throw new Error(`file not found: ${filePath}`)
  const text = await fsSvc.readText(target)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON in ${filePath}: ${safeError(error)}`)
  }
}

async function writeJsonToFs(fsSvc, filePath, data, sandboxPolicy) {
  const target = await fsSvc.resolve(filePath)
  const text = JSON.stringify(data, null, 2) + '\n'
  // Pass the resolved per-session sandbox policy through so the enforcing
  // filesystem honors THIS calling session's mode (e.g. danger-full-access)
  // and workspace root instead of falling back to the no-session deployment
  // default (which denies writes outside the process-cwd root).
  await fsSvc.writeText(target, text, undefined, undefined, sandboxPolicy)
}

/** Resolve a source arg that may be a value string, inline JSON, or @file. */
export async function resolveValueArg(arg, fsSvc, cwd) {
  if (typeof arg !== 'string') return arg
  // `@@` escapes the `@` prefix: `@@pkg` is the literal string `@pkg`
  // (no @file read, no JSON parsing), so scope names like `@scope/name`
  // can be written as values.
  if (arg.startsWith('@@')) return arg.slice(1)
  if (arg.startsWith('@')) {
    const filePath = arg.slice(1).trim()
    if (!fsSvc) throw new Error('@file reads require the fs service')
    return readJsonFromFs(fsSvc, filePath)
  }
  return parseValue(arg)
}

// ── shared presentation ──────────────────────────────────────────────────

const textOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}

function flatRowsToText(rows, schemaMode) {
  const lines = []
  for (const [path, typeName, marker] of rows) {
    if (marker === null) {
      lines.push(`${path} ${typeName}`)
    } else if (marker === '(empty)') {
      lines.push(`${path} ${typeName} (empty)`)
    } else if (marker === '(null)') {
      if (typeName === 'unknown') lines.push(`${path} unknown (null)`)
      else lines.push(`${path} ${typeName} (null)`)
    } else {
      const v = typeof marker === 'string' ? marker : JSON.stringify(marker)
      lines.push(`${path} ${typeName} ${v}`)
    }
  }
  return lines.join('\n')
}

function toObjectRows(rows) {
  return {
    rows: rows.map(([path, type, value]) => ({
      path,
      type,
      value: value === '(empty)' ? '[]' : value === '(null)' ? null : value,
      empty: value === '(empty)',
      nullValue: value === '(null)',
    })),
  }
}

// ── tools ────────────────────────────────────────────────────────────────

export function applyJsonFlat(ctx, config = {}, report = () => {}) {
  const fsSvc = ctx.get('fs')
  // Optional sandbox-policy service: when present, mutating tools resolve the
  // CALLING session's mode/root (not the no-session deployment fallback) so
  // writes are fenced by the session that invoked them.
  const sandboxPolicySvc = ctx.get('sandboxPolicy')
  const registered = []
  const failed = []

  const viewParams = {
    source: {
      type: 'string',
      description: 'JSON 文本、@文件路径（@@ 转义为字面 @ 开头文本），或省略以从 stdin/document 读取',
    },
    file: {
      type: 'string',
      description: '从 fs 服务读取的 JSON 文件路径（优先于 source）',
    },
    schema: { type: 'boolean', description: 'schema 模式：折叠 [N]→[*]、去重、隐藏数值' },
    filter: { type: 'string', description: '仅显示该路径及其子节点（元素感知）' },
    limit: { type: 'integer', description: '最多显示 N 行' },
    offset: { type: 'integer', default: 0, description: '跳过前 N 行' },
    elemOffset: { type: 'integer', default: 0, description: '跳过前 N 个数组元素（与 filter 配合）' },
    elemLimit: { type: 'integer', description: '最多显示 N 个数组元素（与 filter 配合）' },
  }

  try {
    ctx.tools.register(defineTool({
      name: 'json_flat_view',
      description: 'JSON 扁平化查看：列出自 root 到叶子节点的 路径/类型/值。支持 schema 模式、按路径过滤、行级与数组元素级分页。',
      parameters: viewParams,
      output: textOutput,
      async execute(args) {
        const data = await loadData(args, fsSvc)
        const { rows, total, totalElements, shownElements } = prepareView(data, {
          schema: Boolean(args.schema),
          filter: args.filter ?? null,
          limit: typeof args.limit === 'number' ? args.limit : null,
          offset: typeof args.offset === 'number' ? args.offset : 0,
          elemOffset: typeof args.elemOffset === 'number' ? args.elemOffset : 0,
          elemLimit: typeof args.elemLimit === 'number' ? args.elemLimit : null,
        })
        const body = flatRowsToText(rows, Boolean(args.schema))
        const summary = rows.length === 0 ? body : `${body}\n`
        return {
          ok: true,
          mode: args.schema ? 'schema' : 'flat',
          total_rows: total,
          total_elements: totalElements,
          shown_elements: shownElements,
          shown_rows: rows.length,
          text: summary,
        }
      },
    }))
    registered.push('json_flat_view')
  } catch (error) {
    failed.push('json_flat_view')
    report('json_flat_view', error)
  }

  try {
    ctx.tools.register(defineTool({
      name: 'json_flat_schema',
      description: '推断 JSON 的 JSON Schema Draft 7 结构（数组采样前 20 项，required=非空字段）。',
      parameters: {
        source: { type: 'string', description: 'JSON 文本、@文件路径（@@ 转义为字面 @ 开头文本），或省略' },
        file: { type: 'string', description: '从 fs 服务读取的 JSON 文件路径（优先于 source）' },
        title: { type: 'string', description: 'Schema 标题；缺省 "Inferred Schema"' },
      },
      output: textOutput,
      async execute(args) {
        const data = await loadData(args, fsSvc)
        const schema = buildSchema(data, args.title || 'Inferred Schema')
        return {
          ok: true,
          schema,
          text: JSON.stringify(schema, null, 2),
        }
      },
    }))
    registered.push('json_flat_schema')
  } catch (error) {
    failed.push('json_flat_schema')
    report('json_flat_schema', error)
  }

  try {
    ctx.tools.register(defineTool({
      name: 'json_flat_find',
      description: '在 JSON 扁平化路径和值中按 regex 或 glob 搜索；-k 仅路径、-v 仅值、-i 忽略大小写、-g glob 模式。',
      parameters: {
        source: { type: 'string', description: 'JSON 文本、@文件路径（@@ 转义为字面 @ 开头文本），或省略' },
        file: { type: 'string', description: '从 fs 服务读取的 JSON 文件路径（优先于 source）' },
        pattern: { type: 'string', required: true, description: 'regex（默认）或 glob 模式（globMode=true 时，用 * 通配整串）' },
        keyOnly: { type: 'boolean', description: '仅匹配路径' },
        valOnly: { type: 'boolean', description: '仅匹配值' },
        caseInsensitive: { type: 'boolean', description: '忽略大小写' },
        globMode: { type: 'boolean', description: 'true=glob 全串通配；false=regex' },
      },
      output: textOutput,
      async execute(args) {
        const data = await loadData(args, fsSvc)
        const found = findRows(data, args.pattern, {
          keyOnly: Boolean(args.keyOnly),
          valOnly: Boolean(args.valOnly),
          caseInsensitive: Boolean(args.caseInsensitive),
          globMode: Boolean(args.globMode),
        })
        return {
          ok: true,
          count: found.length,
          rows: toObjectRows(found).rows,
          text: found.length ? flatRowsToText(found, false) : '(no matches)',
        }
      },
    }))
    registered.push('json_flat_find')
  } catch (error) {
    failed.push('json_flat_find')
    report('json_flat_find', error)
  }

  try {
    ctx.tools.register(defineTool({
      name: 'json_flat_edit',
      description: '编辑 JSON：set / del / before / after / set-null / copy / merge。读 file 或 source，默认 dry-run 预览 diff，apply=true 时通过 fs 写回。',
      parameters: {
        source: { type: 'string', description: 'JSON 文本、@文件路径（@@ 转义为字面 @ 开头文本），或省略' },
        file: {
          type: 'string',
          required: true,
          description: '要编辑的 JSON 文件路径（需 fs 服务）；写回时覆盖该文件',
        },
        op: {
          type: 'string',
          required: true,
          enum: ['set', 'del', 'set-null', 'before', 'after', 'copy', 'merge'],
          description: '操作类型',
        },
        path: {
          type: 'string',
          required: true,
          description: '路径，如 users[0].name、root.count、tags[2] 等',
        },
        value: { type: 'string', description: '新值（JSON 解析，失败按字符串）；@文件路径可从文件读值；@@ 转义为字面 @ 开头字符串（set/before/after）' },
        srcPath: { type: 'string', description: 'copy 的原路径' },
        dstPath: { type: 'string', description: 'copy 的目标路径' },
        patchFile: { type: 'string', description: 'merge 的补丁 JSON 文件路径' },
        apply: { type: 'boolean', default: false, description: 'true=写回文件；false(默认)=仅 dry-run 预览 diff' },
      },
      output: textOutput,
      async execute(args, exec) {
        if (!fsSvc) throw new Error('json_flat_edit requires the fs service')
        const { file, op } = args
        const data = await readJsonFromFs(fsSvc, file)
        // apply* mutate data in place and return the same reference, so capture
        // a deep clone up front to diff against the pre-mutation state.
        const before = structuredClone(data)

        let result
        let description
        if (op === 'set') {
          const value = await resolveValueArg(args.value, fsSvc, undefined)
          result = applySet(data, parsePath(args.path), value)
          description = `set ${args.path}`
        } else if (op === 'del') {
          result = applyDel(data, parsePath(args.path))
          description = `del ${args.path}`
        } else if (op === 'set-null') {
          result = applySetNull(data, parsePath(args.path))
          description = `set-null ${args.path}`
        } else if (op === 'before') {
          const value = await resolveValueArg(args.value, fsSvc, undefined)
          result = applyBefore(data, parsePath(args.path), value)
          description = `before ${args.path}`
        } else if (op === 'after') {
          const value = await resolveValueArg(args.value, fsSvc, undefined)
          result = applyAfter(data, parsePath(args.path), value)
          description = `after ${args.path}`
        } else if (op === 'copy') {
          if (!args.srcPath || !args.dstPath) throw new Error('copy requires srcPath and dstPath')
          result = applyCopy(data, parsePath(args.srcPath), parsePath(args.dstPath))
          description = `copy ${args.srcPath} → ${args.dstPath}`
        } else if (op === 'merge') {
          if (!args.patchFile) throw new Error('merge requires patchFile')
          const patch = await readJsonFromFs(fsSvc, args.patchFile)
          result = applyMerge(data, parsePath(args.path), patch)
          description = `merge ${args.path}`
        } else {
          throw new Error(`unknown op: ${op}`)
        }

        const diff = diffJson(before, result)
        if (args.apply) {
          const policy = sandboxPolicySvc?.resolve({ ...exec?.agent ? { session: exec.agent.session } : {} })
          await writeJsonToFs(fsSvc, file, result, policy)
          return { ok: true, applied: true, file, op, description, changes: diff }
        }
        return {
          ok: true,
          applied: false,
          dry_run: true,
          file,
          op,
          description,
          changes: diff,
          note: 'dry-run: 传 apply=true 才会写回文件',
        }
      },
    }))
    registered.push('json_flat_edit')
  } catch (error) {
    failed.push('json_flat_edit')
    report('json_flat_edit', error)
  }

    return { registered, failed }
}

// ── data loading ─────────────────────────────────────────────────────────

async function loadData(args, fsSvc) {
  if (args.file && fsSvc) {
    return readJsonFromFs(fsSvc, args.file)
  }
  if (typeof args.source === 'string' && args.source.startsWith('@@')) {
    // `@@` escapes the `@` file-prefix: parse the `@…` remainder as inline JSON/text.
    return parseValue(args.source.slice(1))
  }
  if (typeof args.source === 'string' && args.source.startsWith('@') && fsSvc) {
    return readJsonFromFs(fsSvc, args.source.slice(1).trim())
  }
  if (typeof args.source === 'string' && args.source.trim()) {
    const parsed = parseValue(args.source.trim())
    return parsed
  }
  throw new Error('需要 source（JSON 文本或 @文件路径）或 file（fs 文件路径）')
}

// ── minimal diff (add/del/modify), returns compact per-path records ──────

function diffJson(before, after) {
  const changes = []
  const beforeFlat = new Map(inferNulls(flatten(before)).map(([p, t, v]) => [p, v]))
  const afterFlat = new Map(inferNulls(flatten(after)).map(([p, t, v]) => [p, v]))

  for (const [path, afterValue] of afterFlat) {
    if (!beforeFlat.has(path)) {
      changes.push({ change: 'add', path, after: encodeValue(afterValue) })
    } else if (!deepEqual(beforeFlat.get(path), afterValue)) {
      changes.push({ change: 'modify', path, before: encodeValue(beforeFlat.get(path)), after: encodeValue(afterValue) })
    }
  }
  for (const [path] of beforeFlat) {
    if (!afterFlat.has(path)) changes.push({ change: 'delete', path })
  }
  return changes
}

function encodeValue(v) {
  if (v === null) return null
  if (v === '(empty)') return '<empty>'
  if (v === '(null)') return null
  return typeof v === 'string' ? v : v
}

function deepEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return a === b
  if (typeof a !== 'object') return a === b
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
}
