import { test } from 'node:test'
import assert from 'node:assert'
import {
  flatten,
  signature,
  inferNulls,
  schemaRows,
  filterRows,
  elemOffsetRows,
  elemLimitRows,
  parsePath,
  navigate,
  parseValue,
  applySet,
  applyDel,
  applyBefore,
  applyAfter,
  applySetNull,
  applyCopy,
  deepMerge,
  applyMerge,
  buildSchema,
  findRows,
  prepareView,
} from './json-flat-core.js'

const doc = {
  users: [
    { name: 'Alice', age: 30, active: true, tags: ['a', 'b'] },
    { name: 'Bob', age: null, active: false },
  ],
  count: 2,
  meta: {},
  flag: true,
  ratio: 3.14,
  nothing: null,
}

test('flatten emits root container + leaf triples', () => {
  const rows = flatten(doc)
  assert.strictEqual(rows[0][0], 'root')
  assert.strictEqual(rows[0][1], 'object')
  assert.ok(rows.some(([p]) => p === 'users[0].name'))
  assert.ok(rows.some(([p]) => p === 'users[1].age'))
  assert.ok(rows.some(([p]) => p === 'meta'))
  assert.ok(rows.some(([p, t]) => p === 'count' && t === 'integer'))
  assert.ok(rows.some(([p]) => p === 'root'))
})

test('inferNulls resolves null against sibling structural type', () => {
  const rows = inferNulls(flatten(doc))
  const ageNull = rows.find(([p]) => p === 'users[1].age')
  assert.ok(ageNull)
  // users[0].age is integer → users[1].age null infers to integer
  assert.strictEqual(ageNull[1], 'integer')
  assert.strictEqual(ageNull[2], '(null)')
  const nothing = rows.find(([p]) => p === 'nothing')
  // 'nothing' has no typed sibling → unknown
  assert.strictEqual(nothing[1], 'unknown')
})

test('signature collapses array indices', () => {
  assert.strictEqual(signature('users[0].name'), 'users[*].name')
  assert.strictEqual(signature('users[12]'), 'users[*]')
})

test('schemaRows collapses and dedupes, hides values', () => {
  const s = schemaRows(inferNulls(flatten(doc)))
  // array row stays `users`; its element objects collapse to users[*]
  const arrayRow = s.find(([p]) => p === 'users')
  assert.ok(arrayRow, 'users present')
  assert.strictEqual(arrayRow[1], 'array')
  const elemRow = s.find(([p]) => p === 'users[*]')
  assert.ok(elemRow, 'users[*] present')
  assert.strictEqual(elemRow[1], 'object')
  // users[*].name appears once
  const nameRows = s.filter(([p]) => p === 'users[*].name')
  assert.strictEqual(nameRows.length, 1)
  // value hidden (null marker → not a primitive value)
  assert.strictEqual(nameRows[0][2], null)
})

test('filterRows keeps prefix subtree', () => {
  const rows = filterRows(flatten(doc), 'users')
  assert.ok(rows.every(([p]) => p === 'users' || p.startsWith('users[')))
  assert.ok(rows.some(([p]) => p === 'users[0].name'))
  assert.ok(!rows.some(([p]) => p.startsWith('count')))
})

test('elemOffsetRows and elemLimitRows are element aware', () => {
  const rows = flatten(doc)
  const [limited, total] = elemLimitRows(rows, 'users', 1)
  assert.strictEqual(total, 2)
  // header + all rows under users[0]
  assert.ok(limited.some(([p]) => p === 'users'))
  assert.ok(limited.some(([p]) => p === 'users[0].name'))
  assert.ok(!limited.some(([p]) => p.startsWith('users[1]')))
  const [offset, total2] = elemOffsetRows(rows, 'users', 1)
  assert.strictEqual(total2, 2)
  assert.ok(!offset.some(([p]) => p.startsWith('users[0]')))
  assert.ok(offset.some(([p]) => p === 'users[1].age'))
})

test('parsePath supports mixed keys and indices', () => {
  assert.deepStrictEqual(parsePath('count'), ['count'])
  assert.deepStrictEqual(parsePath('users[0].name'), ['users', 0, 'name'])
  assert.deepStrictEqual(parsePath('tags[2]'), ['tags', 2])
  assert.deepStrictEqual(parsePath('root'), [])
  assert.deepStrictEqual(parsePath('root.count'), ['count'])
  assert.deepStrictEqual(parsePath('root[0]'), [0])
})

test('navigate returns parent/key/node', () => {
  const { parent, key, node } = navigate(doc, parsePath('users[1].age'))
  assert.strictEqual(node, null)
  assert.strictEqual(key, 'age')
  assert.strictEqual(parent, doc.users[1])
})

test('applySet sets a nested field', () => {
  const clone = structuredClone(doc)
  applySet(clone, parsePath('users[0].name'), 'Carol')
  assert.strictEqual(clone.users[0].name, 'Carol')
})

test('applySet at root replaces whole document', () => {
  assert.deepStrictEqual(applySet({ a: 1 }, [], { b: 2 }), { b: 2 })
})

test('applyDel removes dict key and array element', () => {
  const c1 = structuredClone(doc)
  applyDel(c1, parsePath('count'))
  assert.ok(!('count' in c1))
  const c2 = { list: [10, 20, 30] }
  applyDel(c2, parsePath('list[1]'))
  assert.deepStrictEqual(c2.list, [10, 30])
})

test('applyBefore / applyAfter insert around an element', () => {
  const b = { tags: ['x'] }
  applyBefore(b, parsePath('tags[0]'), 'pre')
  assert.deepStrictEqual(b.tags, ['pre', 'x'])
  const a = { tags: ['x'] }
  applyAfter(a, parsePath('tags[0]'), 'post')
  assert.deepStrictEqual(a.tags, ['x', 'post'])
})

test('applySetNull sets null; root → null', () => {
  const c = { a: 1 }
  applySetNull(c, parsePath('a'))
  assert.strictEqual(c.a, null)
  assert.strictEqual(applySetNull({ a: 1 }, []), null)
})

test('applyCopy deep-clones subtree and can append to array', () => {
  const c = { users: [{ name: 'A' }] }
  applyCopy(c, parsePath('users[0]'), parsePath('users[1]'))
  assert.strictEqual(c.users.length, 2)
  assert.strictEqual(c.users[1].name, 'A')
  assert.notStrictEqual(c.users[1], c.users[0])
})

test('deepMerge merges dicts, replaces others', () => {
  assert.deepStrictEqual(deepMerge({ a: 1, n: { x: 1 } }, { n: { y: 2 }, b: 3 }),
    { a: 1, n: { x: 1, y: 2 }, b: 3 })
  assert.deepStrictEqual(deepMerge({ a: [1] }, { a: [2] }), { a: [2] })
})

test('applyMerge targets a subtree', () => {
  const c = { provider: { api: { base: 'x' } }, keep: 1 }
  applyMerge(c, parsePath('provider.api'), { port: 8080 })
  assert.deepStrictEqual(c.provider.api, { base: 'x', port: 8080 })
  assert.strictEqual(c.keep, 1)
})

test('buildSchema infers Draft-07 schema', () => {
  const s = buildSchema({ age: 30, name: 'A', ok: true, tags: ['x', 'y'], none: null }, 'Doc')
  assert.strictEqual(s.$schema, 'http://json-schema.org/draft-07/schema#')
  assert.strictEqual(s.title, 'Doc')
  assert.strictEqual(s.type, 'object')
  assert.strictEqual(s.properties.age.type, 'integer')
  assert.strictEqual(s.properties.name.type, 'string')
  assert.strictEqual(s.properties.ok.type, 'boolean')
  assert.strictEqual(s.properties.tags.type, 'array')
  assert.strictEqual(s.properties.tags.items.type, 'string')
  assert.strictEqual(s.properties.none.type, 'null')
  // non-empty fields are required
  assert.deepStrictEqual(s.required.sort(), ['age', 'name', 'ok', 'tags'])
})

test('findRows matches path by regex', () => {
  const found = findRows(doc, 'users\\[\\d+\\]\\.name', {})
  assert.strictEqual(found.length, 2)
  assert.ok(found.every(([p]) => p.startsWith('users[')))
})

test('findRows glob case-insensitive value search', () => {
  const found = findRows(doc, '*ALICE*', { caseInsensitive: true, globMode: true, valOnly: true })
  assert.strictEqual(found.length, 1)
  assert.strictEqual(found[0][0], 'users[0].name')
})

test('findRows keyOnly vs valOnly', () => {
  const key = findRows(doc, 'count', { keyOnly: true })
  // only the path `count` itself contains the string 'count'
  assert.deepStrictEqual(key.map(([p]) => p), ['count'])
  // valOnly on the number 3.14 finds only the ratio leaf
  const val = findRows(doc, '3\\.14', { valOnly: true })
  assert.deepStrictEqual(val.map(([p]) => p), ['ratio'])
})

test('prepareView applies filter then row pagination', () => {
  const { rows } = prepareView(doc, { filter: 'users', limit: 3 })
  assert.strictEqual(rows.length, 3)
  assert.ok(rows.every(([p]) => p === 'users' || p.startsWith('users[')))
})

test('prepareView element slicing returns totals', () => {
  const { rows, totalElements, shownElements } = prepareView(doc, { filter: 'users', elemLimit: 1 })
  assert.strictEqual(totalElements, 2)
  assert.strictEqual(shownElements, 1)
  assert.ok(rows.some(([p]) => p === 'users[0].name'))
  assert.ok(!rows.some(([p]) => p.startsWith('users[1]')))
})
