import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, test, vi } from 'vitest'
import { createOverviewDatabaseCache } from '../../src/host/overviewDatabaseCache'
import { dayKeyOf } from '../../src/shared/days'
import { openOverviewDatabase } from '../../src/host/overviewDatabase'
import { queryDays } from '../../src/host/overviewDatabaseQuery'
import {
  boot, call, recordOf, timelineOf, timingOf, usageOf, dayOf,
  type BootOptions, type CallResult, type Harness,
} from './helpers/overview'

const dirs: string[] = []

function tempDir(): string {
  mkdirSync(resolve('.tmp'), { recursive: true })
  const dir = mkdtempSync(join(resolve('.tmp'), 'dsh-ovdb-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NOW = Date.now()

const TODAY = dayKeyOf(NOW)!

const YESTERDAY = dayKeyOf(NOW - 24 * 60 * 60 * 1_000)!

function valuesOf(tokens: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contextTimeline: timelineOf({
      total: tokens * 2,
      turns: 2,
      steps: 3,
      cost: usageOf(tokens, 2, 1, 3),
      model: 'deepseek-v4-flash',
      lastUser: 'hello 100% ü',
      timing: timingOf(1_000, 2, 100),
    }),
    contextActivity: {
      days: {
        [TODAY]: dayOf(tokens, 1, { cost: usageOf(tokens, 2, 1, 3), turns: 1, toolCalls: 1, skills: ['tdd'], tools: ['read'], cmds: ['git'] }),
        [YESTERDAY]: dayOf(2, 1, { cost: usageOf(2, 0, 0, 1), turns: 1, tools: ['read'], cmds: ['npm'] }),
      },
    },
    title: `Session ${tokens}`,
    sessionListMetadata: { blank: false, lastPromptAt: NOW - tokens },
    ...over,
  }
}

function corpus(): BootOptions {
  return {
    records: [
      recordOf('root', { cwd: '/repo/root' }),
      recordOf('live', { cwd: '/repo/live', live: true }),
      recordOf('kid', { cwd: '/repo/kid', parentSession: 'root', origin: 'subagent' }),
      recordOf('older', { cwd: '/repo/older' }),
      recordOf('plain', { cwd: '/repo/plain' }),
    ],
    values: {
      root: valuesOf(100),
      kid: valuesOf(10),
      older: valuesOf(100),
      plain: { title: 'No timeline', contextTimeline: null, contextActivity: null },
    },
    liveValues: { live: valuesOf(40) },
    liveSeq: { live: 1 },
    workspace: { list: () => [{ id: 'w1', title: 'Team One', sessionIds: ['root', 'live', 'older'] }], archivedSessionIds: ['older'] },
  }
}

interface Pair {
  js: Harness
  db: Harness
  dbPath: string
}

async function bootPair(options: BootOptions): Promise<Pair> {
  const dir = tempDir()
  const dbPath = join(dir, 'stats.sqlite')
  const js = await boot({ ...options, noCache: true, cachePath: join(dir, 'js-cache.json') })
  const db = await boot({ ...options, noCache: true, cachePath: join(dir, 'db-cache.json'), databasePath: dbPath })
  return { js, db, dbPath }
}

function assertSame(actual: unknown, expected: unknown, path = '$'): void {
  if (path.endsWith('.costUsd') && typeof actual === 'number' && typeof expected === 'number') {
    assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${path}: non-finite`)
    assert.ok(Math.abs(actual - expected) <= 1e-9, `${path}: ${String(actual)} != ${String(expected)}`)
    return
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${path}: length`)
    actual.forEach((value, index) => { assertSame(value, expected[index], `${path}[${index}]`) })
    return
  }
  if (actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object') {
    const left = actual as Record<string, unknown>
    const right = expected as Record<string, unknown>
    assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort(), `${path}: keys`)
    for (const key of Object.keys(right)) assertSame(left[key], right[key], `${path}.${key}`)
    return
  }
  assert.deepEqual(actual, expected, path)
}

async function same(pair: Pair, body: unknown): Promise<CallResult> {
  const js = await call(pair.js, body)
  const db = await call(pair.db, body)
  assert.equal(js.reply.ok, true, `${JSON.stringify(body)} js reply ok`)
  assert.equal(db.reply.ok, true, `${JSON.stringify(body)} db reply ok`)
  assertSame(db.reply.value, js.reply.value, JSON.stringify(body))
  return db
}

const PARTS = [
  { part: 'summary' },
  { part: 'days' },
  { part: 'page' },
  { part: 'tally', tally: 'skills' },
  { part: 'tally', tally: 'tools' },
  { part: 'tally', tally: 'cmds' },
]

const SCOPES = [
  {},
  { range: 'all' },
  { range: '30d' },
  { range: '7d' },
  { range: 'today' },
  { day: TODAY },
  { coverage: 'active' },
  { coverage: 'archived' },
  { group: 'Team One' },
  { group: '__ungrouped__' },
  { query: 'ü' },
  { query: '100%' },
  { query: 'SESSION' },
]

describe('overview database route', () => {
  test('SQL and JS aggregation agree across parts, scopes, sorts, pagination and picks', async () => {
    const pair = await bootPair(corpus())
    for (const part of PARTS) {
      for (const scope of SCOPES) await same(pair, { ...part, scope })
    }
    for (const sort of ['recent', 'tokens', 'context']) {
      for (const page of [0, 1, 5]) await same(pair, { part: 'page', scope: { range: 'all' }, sort, page })
    }
    for (const part of ['summary', 'page', 'tally'] as const) {
      await same(pair, { part, ...(part === 'tally' ? { tally: 'tools' } : {}), scope: { pick: { field: 'tools', name: 'read' } } })
    }
    assert.ok(existsSync(pair.dbPath) && statSync(pair.dbPath).size > 0, 'the database file is populated')
    const opened = openOverviewDatabase({ path: pair.dbPath })
    assert.ok(opened !== null, 'the database opens after the route synced it')
    assert.ok(opened.revision !== null && opened.revision !== '', 'a revision is committed')
    const sqlDays = queryDays(opened, opened.revision, 'all')
    assert.ok(sqlDays !== undefined && sqlDays.length > 0, 'SQL days answer at the committed revision')
    opened.close()
    const first = await same(pair, { part: 'summary' })
    const revision = (first.reply.value as { revision: string }).revision
    const unchanged = await call(pair.db, { part: 'summary', revision })
    assert.deepEqual(unchanged.reply.value, { revision, unchanged: true })
    const jsUnchanged = await call(pair.js, { part: 'summary', revision })
    assert.deepEqual(jsUnchanged.reply.value, { revision, unchanged: true })
    pair.js.dispose()
    pair.db.dispose()
  })

  test('SQL and JS stay equal across live updates, archives, additions, deletions, folds and price versions', async () => {
    let version = 0
    const options = corpus()
    options.costVersion = () => version
    const pair = await bootPair(options)
    await same(pair, { part: 'summary' })
    await same(pair, { part: 'days' })
    await same(pair, { part: 'page' })
    const records = options.records as unknown[]
    const liveSeq = options.liveSeq as Record<string, number>
    liveSeq.live = 2
    await same(pair, { part: 'summary' })
    await same(pair, { part: 'page', sort: 'tokens' })
    const workspace = options.workspace as { archivedSessionIds: string[] }
    workspace.archivedSessionIds.push('root')
    await same(pair, { part: 'summary' })
    await same(pair, { part: 'page', scope: { coverage: 'active' } })
    records.push(recordOf('added', { cwd: '/repo/added' }))
    ;(options.values as Record<string, unknown>).added = valuesOf(7)
    await same(pair, { part: 'summary' })
    await same(pair, { part: 'days' })
    const index = records.findIndex(record => (record as { header?: { id?: string } }).header?.id === 'plain')
    records.splice(index, 1)
    await same(pair, { part: 'summary' })
    await same(pair, { part: 'page' })
    const values = options.values as Record<string, Record<string, unknown>>
    values.root = valuesOf(55)
    for (const harness of [pair.js, pair.db]) {
      harness.state.foldedVersion = 1
      harness.state.foldedIds = ['root']
    }
    await same(pair, { part: 'summary' })
    await same(pair, { part: 'page' })
    version = 3
    await same(pair, { part: 'summary' })
    await same(pair, { part: 'days' })
    pair.js.dispose()
    pair.db.dispose()
  })

  test('one revision syncs once and a later SQL read failure preserves authoritative results', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'read-failure.sqlite')
    const database = openOverviewDatabase({ path: dbPath })
    assert.ok(database !== null)
    const sync = vi.spyOn(database, 'syncRows')
    const cache = createOverviewDatabaseCache({ database, cachePath: join(dir, 'fallback.json') })
    const options = corpus()
    const js = await boot(options)
    const db = await boot({ ...options, cache, idleMs: 0 })
    const pair = { js, db, dbPath }
    try {
      for (const body of PARTS) await same(pair, body)
      assert.equal(new Set(sync.mock.calls.map(args => args[1])).size, 1, 'the six parts share one revision')
      assert.equal(sync.mock.calls.length, 1, JSON.stringify(db.calls))
      vi.spyOn(database, 'all').mockImplementationOnce(() => { throw new Error('read failed') })
      const recovered = await same(pair, { part: 'page', sort: 'tokens' })
      assert.ok(recovered.reply.value !== undefined && 'page' in recovered.reply.value)
      assert.ok(recovered.reply.value.page.total > 0)
      assert.equal(database.available, false)
      for (const body of PARTS) await same(pair, body)
      assert.equal(sync.mock.calls.length, 1, 'a disabled index is not retried on every request')
    } finally {
      js.dispose()
      db.dispose()
    }
  })

  test('a busy index write closes the optional database and serves the full JS result', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'busy.sqlite')
    const database = openOverviewDatabase({ path: dbPath })
    const blocker = openOverviewDatabase({ path: dbPath })
    assert.ok(database !== null && blocker !== null)
    const cache = createOverviewDatabaseCache({ database, cachePath: join(dir, 'fallback.json') })
    const options = corpus()
    const js = await boot(options)
    const db = await boot({ ...options, cache })
    blocker.all('BEGIN IMMEDIATE')
    try {
      const result = await same({ js, db, dbPath }, { part: 'summary' })
      assert.ok(result.reply.value !== undefined && 'summary' in result.reply.value)
      assert.ok(result.reply.value.summary.sessions > 0)
      assert.equal(database.available, false)
      await same({ js, db, dbPath }, { part: 'page' })
      await same({ js, db, dbPath }, { part: 'days' })
    } finally {
      blocker.all('ROLLBACK')
      blocker.close()
      js.dispose()
      db.dispose()
    }
  })

  test('an explicit database path works without a legacy cache path', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'standalone.sqlite')
    const harness = await boot({ ...corpus(), noCache: true, databasePath: dbPath })
    try {
      const result = await call(harness, { part: 'page' })
      assert.ok(result.reply.ok && result.reply.value !== undefined && 'page' in result.reply.value)
      assert.ok(result.reply.value.page.total > 0)
      assert.ok(existsSync(dbPath))
    } finally {
      harness.dispose()
    }
  })

  test('a corrupt database file falls back to the authoritative JS aggregation', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'broken.sqlite')
    writeFileSync(dbPath, 'not a sqlite database at all')
    const options = corpus()
    const js = await boot({ ...options, noCache: true, cachePath: join(dir, 'js-cache.json') })
    const db = await boot({ ...options, noCache: true, cachePath: join(dir, 'db-cache.json'), databasePath: dbPath })
    const pair: Pair = { js, db, dbPath }
    for (const body of [{ part: 'summary' }, { part: 'days' }, { part: 'page' }, { part: 'tally', tally: 'tools' }]) {
      const result = await same(pair, body)
      if (body.part === 'summary') {
        const summary = result.reply.value as { summary: { sessions: number } }
        assert.ok(summary.summary.sessions > 0, 'the fallback still serves real rows')
      }
    }
    js.dispose()
    db.dispose()
  })
})
