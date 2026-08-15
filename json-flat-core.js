/**
 * json-flat-core — plain-JS port of the `jstool.py` JSON flat view & edit tool.
 *
 * Kept dependency-free and deterministic so it can be unit-tested without the
 * DSH runtime and reused by the Cordis plugin tools. All functions are pure:
 * they take and return plain JSON values (no live service references, no
 * ordering-by-fast-path containers).
 *
 * Ported behavior parity with jstool.py:
 *   - flatten / schema_rows / infer_nulls / filter_rows / elem slicing
 *   - parse_path / navigate / parse_value
 *   - apply_set / apply_del / apply_before / apply_after / apply_set_null
 *   - apply_copy / deep_merge / apply_merge
 *   - _infer JSON Schema inference (Draft-07 flavored)
 *   - find path/value matching (regex or glob, case-insensitive)
 */

// ── Null inference ───────────────────────────────────────────────────────

/** Collapse [N] → [*] for structural path comparison. */
export function signature(path) {
  return path.replace(/\[\d+\]/g, '[*]')
}

/**
 * Replace ambiguous JSON `null` rows with a sibling-inferred type where
 * possible. Mirrors jstool.py `infer_nulls`:
 *   - a row with JSON null and unknown type becomes "unknown" (red)
 *   - a row whose structural sibling is a known primitive takes that type
 *   - container rows keep their own type
 *
 * Returns a new array of [path, typeName, valueMarker] triples.
 */
export function inferNulls(rows) {
  const known = new Map()
  for (const [path, typeName, value] of rows) {
    if (value === null || value === '(empty)') continue
    if (typeName === 'null' || typeName === 'object' || typeName === 'array') continue
    const s = signature(path)
    if (!known.has(s)) known.set(s, typeName)
  }
  return rows.map(([path, typeName, value]) => {
    if (typeName === 'null' && value === null) {
      return [path, known.get(signature(path)) || 'unknown', '(null)']
    }
    return [path, typeName, value]
  })
}

// ── Flatten ──────────────────────────────────────────────────────────────

/** Get the JSON-ish type name of a value. */
export function getTypeName(data) {
  if (data === null) return 'null'
  if (typeof data === 'boolean') return 'boolean'
  if (typeof data === 'number') return Number.isInteger(data) ? 'integer' : 'number'
  if (typeof data === 'string') return 'string'
  if (Array.isArray(data)) return 'array'
  if (typeof data === 'object') return 'object'
  return 'unknown'
}

/**
 * Flatten a JSON value into [path, typeName, valueMarker] triples.
 * valueMarker semantics (same as jstool):
 *   - null      → container with children
 *   - '(empty)' → empty container
 *   - '(null)'  → JSON null primitive (type already inferred)
 *   - any other → primitive value
 */
export function flatten(data, path = 'root', rootLevel = true) {
  const rows = []
  if (Array.isArray(data)) {
    rows.push([path, 'array', data.length ? null : '(empty)'])
    for (let i = 0; i < data.length; i++) {
      rows.push(...flatten(data[i], `${path}[${i}]`, false))
    }
  } else if (data !== null && typeof data === 'object') {
    rows.push([path, 'object', Object.keys(data).length ? null : '(empty)'])
    for (const k of Object.keys(data)) {
      const child = rootLevel ? k : `${path}.${k}`
      rows.push(...flatten(data[k], child, false))
    }
  } else {
    rows.push([path, getTypeName(data), data])
  }
  return rows
}

/**
 * Collapse array indices to [*] and deduplicate by (structural path, type);
 * primitive values are hidden (type shown only). Order preserved, first wins.
 */
export function schemaRows(rows) {
  const seen = new Set()
  const result = []
  for (const [path, typeName, value] of rows) {
    if (typeName === 'array' || typeName === 'object') {
      // Preserve "(empty)" marker on collapsed paths but not containers up front.
      const struct = signature(path)
      const key = `${struct}:${typeName}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push([struct, typeName, value])
      continue
    }
    const struct = signature(path)
    const key = `${struct}:${typeName}`
    if (seen.has(key)) continue
    seen.add(key)
    // Hide actual primitive values; keep null/empty markers.
    const display = value === null || value === '(empty)' || value === '(null)' ? value : null
    result.push([struct, typeName, display])
  }
  return result
}

/** Keep rows whose path equals prefix or starts with `prefix.` / `prefix[`. */
export function filterRows(rows, prefix) {
  return rows.filter(([p]) => p === prefix || p.startsWith(prefix + '.') || p.startsWith(prefix + '['))
}

const ELEM_RE = (filterPath) => new RegExp('^' + escapeRegExp(filterPath) + '\\[(\\d+)\\]')

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function groupElements(rows, filterPath) {
  const re = ELEM_RE(filterPath)
  const headerRows = []
  const groups = new Map()
  const order = []
  for (const row of rows) {
    const m = re.exec(row[0])
    if (m) {
      const idx = Number(m[1])
      if (!groups.has(idx)) {
        groups.set(idx, [])
        order.push(idx)
      }
      groups.get(idx).push(row)
    } else {
      headerRows.push(row)
    }
  }
  return { headerRows, groups, order }
}

/**
 * Skip the first elemSkip array elements under filterPath. Direct-child rows of
 * filterPath (filterPath[N]...) cluster per element; header row kept.
 * Returns [rows, totalElements].
 */
export function elemOffsetRows(rows, filterPath, elemSkip) {
  const { headerRows, groups, order } = groupElements(rows, filterPath)
  const kept = order.slice(elemSkip)
  const result = [...headerRows]
  for (const idx of kept) result.push(...groups.get(idx))
  return [result, order.length]
}

/**
 * Keep at most the first elemCount array elements under filterPath.
 * Returns [rows, totalElements].
 */
export function elemLimitRows(rows, filterPath, elemCount) {
  const { headerRows, groups, order } = groupElements(rows, filterPath)
  const kept = order.slice(0, elemCount)
  const result = [...headerRows]
  for (const idx of kept) result.push(...groups.get(idx))
  return [result, order.length]
}

// ── Path parser ──────────────────────────────────────────────────────────

/**
 * Parse a path string into segments.
 *   'users[0].name' → ['users', 0, 'name']
 *   'tags[2]'       → ['tags', 2]
 *   'count'         → ['count']
 *   'root'          → []
 *   'root.count'    → ['count']
 *   'root[0]'       → [0]
 */
export function parsePath(pathStr) {
  let s = pathStr.trim()
  if (s === 'root') return []
  if (s.startsWith('root.')) s = s.slice(5)
  else if (s.startsWith('root[')) s = s.slice(4)

  const segments = []
  let i = 0
  while (i < s.length) {
    if (s[i] === '[') {
      const j = s.indexOf(']', i)
      if (j === -1) throw new Error(`Unterminated '[' in path: ${pathStr}`)
      const idxStr = s.slice(i + 1, j)
      if (!/^\d+$/.test(idxStr)) throw new Error(`Non-integer index in path: ${s.slice(i, j + 1)}`)
      segments.push(Number(idxStr))
      i = j + 1
      if (i < s.length && s[i] === '.') i += 1
    } else {
      let j = i
      while (j < s.length && s[j] !== '.' && s[j] !== '[') j += 1
      const key = s.slice(i, j)
      if (!key) throw new Error(`Empty key in path: ${pathStr}`)
      segments.push(key)
      i = j
      if (i < s.length && s[i] === '.') i += 1
    }
  }
  return segments
}

/**
 * Walk data by segments. Returns { parent, key, node } where parent is the
 * container holding node and key is the string/int used to reach it.
 */
export function navigate(data, segments) {
  let parent = null
  let key = null
  let node = data
  for (const seg of segments) {
    parent = node
    key = seg
    if (typeof seg === 'string') {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) {
        throw new Error(`Expected object to look up key ${JSON.stringify(seg)}, got ${getTypeName(node)}`)
      }
      if (!(seg in node)) throw new Error(`Key not found: ${JSON.stringify(seg)}`)
      node = node[seg]
    } else {
      if (!Array.isArray(node)) {
        throw new Error(`Expected array for index ${seg}, got ${getTypeName(node)}`)
      }
      if (!(-node.length <= seg && seg < node.length)) {
        throw new Error(`Index ${seg} out of range (len=${node.length})`)
      }
      node = node[seg]
    }
  }
  return { parent, key, node }
}

// ── Value parser ─────────────────────────────────────────────────────────

/**
 * Parse a value string: JSON first, fall back to plain string.
 * Mirrors jstool.py `parse_value` (without the `@file` read, which the plugin
 * handles separately through the `fs` service).
 */
export function parseValue(valStr) {
  if (typeof valStr === 'object' && valStr !== null) return valStr
  try {
    return JSON.parse(valStr)
  } catch {
    return valStr
  }
}

// ── Apply changes ────────────────────────────────────────────────────────

export function applySet(data, segments, newVal) {
  if (!segments.length) return newVal
  const { parent, key } = navigate(data, segments)
  parent[key] = newVal
  return data
}

export function applyDel(data, segments) {
  if (!segments.length) throw new Error('Cannot delete root')
  const { parent, key } = navigate(data, segments)
  if (Array.isArray(parent)) parent.splice(key, 1)
  else delete parent[key]
  return data
}

export function applyBefore(data, segments, newVal) {
  if (!segments.length) throw new Error('Cannot insert before root')
  const { parent, key } = navigate(data, segments)
  if (!Array.isArray(parent)) throw new Error("'before' only works on array elements")
  parent.splice(key, 0, newVal)
  return data
}

export function applyAfter(data, segments, newVal) {
  if (!segments.length) throw new Error('Cannot insert after root')
  const { parent, key } = navigate(data, segments)
  if (!Array.isArray(parent)) throw new Error("'after' only works on array elements")
  parent.splice(key + 1, 0, newVal)
  return data
}

export function applySetNull(data, segments) {
  if (!segments.length) return null
  const { parent, key } = navigate(data, segments)
  parent[key] = null
  return data
}

export function applyCopy(data, srcSegs, dstSegs) {
  const { node: srcVal } = navigate(data, srcSegs)
  const newVal = structuredClone(srcVal)
  if (dstSegs.length) {
    const parentSegs = dstSegs.slice(0, -1)
    const lastSeg = dstSegs[dstSegs.length - 1]
    const { node: parent } = navigate(data, parentSegs)
    if (Array.isArray(parent) && typeof lastSeg === 'number' && lastSeg >= parent.length) {
      parent.push(newVal)
      return data
    }
  }
  return applySet(data, dstSegs, newVal)
}

/** Recursively merge patch into base: dicts merge, all other types replaced. */
export function deepMerge(base, patch) {
  if (base !== null && typeof base === 'object' && !Array.isArray(base)
      && patch !== null && typeof patch === 'object' && !Array.isArray(patch)) {
    const result = { ...base }
    for (const k of Object.keys(patch)) {
      result[k] = k in result ? deepMerge(result[k], patch[k]) : patch[k]
    }
    return result
  }
  return patch
}

export function applyMerge(data, segs, patch) {
  if (!segs.length) return deepMerge(data, patch)
  const { parent, key, node } = navigate(data, segs)
  parent[key] = deepMerge(node, patch)
  return data
}

// ── JSON Schema inference (Draft-07 flavored) ────────────────────────────

const SCHEMA_SAMPLE = 20

/** Merge a list of inferred item schemas into one. */
function mergeSchemas(schemas) {
  if (!schemas.length) return {}
  if (schemas.length === 1) return schemas[0]

  const types = new Set()
  for (const s of schemas) {
    if (s && typeof s === 'object' && s.type) types.add(s.type)
  }
  if (types.size === 0) return {}

  if (types.size === 1) {
    const t = [...types][0]
    if (t === 'object') {
      const allProps = {}
      const requiredSets = []
      for (const s of schemas) {
        for (const [k, v] of Object.entries(s.properties || {})) {
          if (!(k in allProps)) allProps[k] = v
        }
        if (Array.isArray(s.required)) requiredSets.push(new Set(s.required))
      }
      const result = { type: 'object', properties: allProps }
      if (requiredSets.length) {
        let common = requiredSets[0]
        for (const rs of requiredSets.slice(1)) {
          common = new Set([...common].filter((x) => rs.has(x)))
        }
        if (common.size) result.required = [...common].sort()
      }
      return result
    }
    if (t === 'array') {
      const sub = schemas.map((s) => (s && s.items) || {})
      return { type: 'array', items: mergeSchemas(sub) }
    }
    return { type: t }
  }

  const nonNull = [...types].filter((t) => t !== 'null')
  if (nonNull.length === 1 && types.has('null')) {
    return { type: nonNull[0], nullable: true }
  }
  return { oneOf: [...types].sort().map((t) => ({ type: t })) }
}

/** Recursively infer JSON Schema for a value. */
export function inferSchema(data) {
  if (data === null) return { type: 'null' }
  if (typeof data === 'boolean') return { type: 'boolean' }
  if (typeof data === 'number') return { type: Number.isInteger(data) ? 'integer' : 'number' }
  if (typeof data === 'string') return { type: 'string' }

  if (Array.isArray(data)) {
    if (!data.length) return { type: 'array', items: {} }
    const samples = data.slice(0, SCHEMA_SAMPLE)
    const itemSchemas = samples.map(inferSchema)
    return { type: 'array', items: mergeSchemas(itemSchemas) }
  }

  if (data !== null && typeof data === 'object') {
    if (!Object.keys(data).length) return { type: 'object', properties: {} }
    const properties = {}
    const required = []
    for (const key of Object.keys(data)) {
      properties[key] = inferSchema(data[key])
      const v = data[key]
      if (v !== null && v !== '' && v !== undefined
          && !(Array.isArray(v) && v.length === 0)
          && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) {
        required.push(key)
      }
    }
    const result = { type: 'object', properties }
    if (required.length) result.required = required.sort()
    return result
  }

  return {}
}

/** Build a full Draft-07 schema envelope from data. */
export function buildSchema(data, title = 'Inferred Schema') {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title,
  }
  Object.assign(schema, inferSchema(data))
  return schema
}

// ── Find / view presentation ─────────────────────────────────────────────

const ANON = '(empty)'

/** Pick the friendly primitive display string for a value marker, or ''. */
function markerString(marker) {
  if (marker === null || marker === undefined || marker === ANON) return ''
  return typeof marker === 'string' ? marker : JSON.stringify(marker)
}

/**
 * Search flattened rows by path and/or value.
 * options: { keyOnly, valOnly, caseInsensitive, globMode, pattern }
 * Returns an array of matching [path, typeName, valueMarker] triples.
 */
export function findRows(data, pattern, options = {}) {
  const rows = inferNulls(flatten(data))
  const { keyOnly = false, valOnly = false, caseInsensitive = false, globMode = false } = options

  let matches
  if (globMode) {
    const pat = caseInsensitive ? pattern.toLowerCase() : pattern
    matches = (text) => {
      const t = caseInsensitive ? text.toLowerCase() : text
      return fnmatch(t, pat)
    }
  } else {
    let compiled
    try {
      compiled = new RegExp(pattern, caseInsensitive ? 'i' : '')
    } catch (e) {
      throw new Error(`Invalid regex: ${e.message}`)
    }
    matches = (text) => compiled.test(text)
  }

  const result = []
  for (const [path, typeName, marker] of rows) {
    const valStr = markerString(marker)
    const hitKey = matches(path)
    let hit
    if (keyOnly) hit = hitKey
    else if (valOnly) hit = Boolean(valStr) && matches(valStr)
    else hit = hitKey || (Boolean(valStr) && matches(valStr))
    if (hit) result.push([path, typeName, marker])
  }
  return result
}

/**
 * Full-command-oriented prepare: produce the final row list for `view`.
 * options: { schema, filter, limit, offset, elemOffset, elemLimit }
 * Returns { rows, total, totalElements, shownStart, shownEnd }.
 */
export function prepareView(data, options = {}) {
  const { schema = false, filter = null, limit = null, offset = 0,
          elemOffset = 0, elemLimit = null } = options

  let rows = inferNulls(flatten(data))
  if (schema) rows = schemaRows(rows)
  if (filter !== null && filter !== undefined) rows = filterRows(rows, filter)

  let totalElements = null
  let shownElements = null

  if ((elemOffset > 0 || elemLimit !== null) && filter !== null && filter !== undefined) {
    if (elemOffset > 0) {
      const [r, total] = elemOffsetRows(rows, filter, elemOffset)
      rows = r
      totalElements = total
    }
    if (elemLimit !== null) {
      const [r, te] = elemLimitRows(rows, filter, elemLimit)
      rows = r
      if (totalElements === null) totalElements = te
    } else if (totalElements === null) {
      const [, total] = elemOffsetRows(rows, filter, 0)
      totalElements = total
    }
    shownElements = elemLimit !== null ? elemLimit : totalElements - elemOffset
  } else if (elemOffset > 0) {
    offset = elemOffset
  }

  const total = rows.length
  rows = rows.slice(offset)
  if (limit !== null) rows = rows.slice(0, limit)

  return { rows, total, totalElements, shownElements, offsetApplied: offset }
}

/**
 * tiny glob matcher (fnmatch subset: '*' = any chars, '?' = one char).
 */
function fnmatch(text, pattern) {
  let p = pattern
  let regex = '^'
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') regex += '.*'
    else if (c === '?') regex += '.'
    else regex += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  regex += '$'
  return new RegExp(regex).test(text)
}
