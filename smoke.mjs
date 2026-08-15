/**
 * Smoke test: load json-flat implementation with a mock ctx, verify the four
 * tools register, and exercise the read-only tools end-to-end (view/schema/find).
 * Editing tools require `fs`, so they are exercised with a tiny in-memory fs mock.
 */
import { applyJsonFlat } from './implementation.js'

const registered = []
const tools = {
  register(tool) {
    registered.push(tool.name)
    return () => {}
  },
}

// In-memory fs mock providing resolve/stat/readText/writeText.
class MemFs {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files))
  }
  async resolve(p) { return { path: p } }
  async stat(target) { return this.files.has(target.path) ? { size: 1, exists: true } : undefined }
  async readText(target) {
    if (!this.files.has(target.path)) throw new Error(`missing ${target.path}`)
    return this.files.get(target.path)
  }
  async writeText(target, text) { this.files.set(target.path, text) }
}

const files = {
  'config.json': JSON.stringify({ users: [{ name: 'Alice', age: 30 }], count: 1 }),
}
const fsSvc = new MemFs(files)

const mockCtx = {
  tools,
  get(name) {
    if (name === 'tools') return tools
    if (name === 'fs') return fsSvc
    return undefined
  },
}

const result = applyJsonFlat(mockCtx, {}, (scope, err) => {
  console.error(`[report] ${scope}: ${err.message}`)
})
console.log('registered:', result.registered)
console.log('failed:', result.failed)

const expected = ['json_flat_view', 'json_flat_schema', 'json_flat_find', 'json_flat_edit']
if (JSON.stringify(result.registered.sort()) !== JSON.stringify([...expected].sort())) {
  console.error('SMOKE FAIL: wrong registration set')
  process.exit(1)
}
if (result.failed.length !== 0) {
  console.error('SMOKE FAIL: some tools failed to register')
  process.exit(1)
}

// Pull the registered executor functions from stored tools for end-to-end checks.
const byName = new Map()
tools.register = (tool) => { byName.set(tool.name, tool); registered.push(tool.name); return () => {} }
applyJsonFlat(mockCtx, {}, (scope, err) => { console.error(`[report] ${scope}: ${err.message}`) })

async function run(name, args) {
  const tool = byName.get(name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  // invoke execute through its wrapper (validate + execute). We emulate by
  // calling the raw execute directly with already-valid args.
  return tool.execute(args, {})
}

// read-only: file-based view
const viewOut = await run('json_flat_view', { file: 'config.json' })
if (!viewOut.ok || viewOut.total_rows < 4) {
  console.error('SMOKE FAIL: view did not flatten config.json')
  process.exit(1)
}
console.log('view rows:', viewOut.total_rows)

const schemaOut = await run('json_flat_schema', { file: 'config.json', title: 'Config' })
if (!schemaOut.ok || schemaOut.schema.title !== 'Config' || schemaOut.schema.properties.users.type !== 'array') {
  console.error('SMOKE FAIL: schema inference wrong')
  process.exit(1)
}
console.log('schema ok:', schemaOut.schema.properties.users.type)

const findOut = await run('json_flat_find', { file: 'config.json', pattern: 'Alice' })
if (!findOut.ok || findOut.count !== 1) {
  console.error('SMOKE FAIL: find did not locate Alice')
  process.exit(1)
}
console.log('find count:', findOut.count)

// read-only: inline source
const inlineView = await run('json_flat_view', { source: '{"a":1}' })
if (!inlineView.ok || inlineView.total_rows !== 2) {
  console.error('SMOKE FAIL: inline source view wrong')
  process.exit(1)
}
console.log('inline view rows:', inlineView.total_rows)

// edit dry-run (no write)
const dryRun = await run('json_flat_edit', {
  file: 'config.json', op: 'set', path: 'count', value: '9', apply: false,
})
if (!dryRun.ok || dryRun.applied !== false || dryRun.changes.length !== 1) {
  console.error('SMOKE FAIL: dry-run edit wrong')
  process.exit(1)
}
if (fsSvc.files.get('config.json').includes('"count": 9')) {
  console.error('SMOKE FAIL: dry-run unexpectedly wrote file')
  process.exit(1)
}
console.log('dry-run changes:', dryRun.changes.length)

// edit apply (writes back)
const applied = await run('json_flat_edit', {
  file: 'config.json', op: 'set', path: 'count', value: '9', apply: true,
})
if (!applied.ok || applied.applied !== true) {
  console.error('SMOKE FAIL: apply edit wrong')
  process.exit(1)
}
if (!fsSvc.files.get('config.json').includes('"count": 9')) {
  console.error('SMOKE FAIL: apply did not write file')
  process.exit(1)
}
console.log('apply ok: count changed to 9')

console.log('SMOKE OK')
