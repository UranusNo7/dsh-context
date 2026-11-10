import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import type { SessionCostUsage } from '../../src/shared/types'
import { createOverviewDatabaseCache, type OverviewDatabaseCache } from '../../src/host/overviewDatabaseCache'
import { openOverviewDatabase, type OverviewStatsDatabase } from '../../src/host/overviewDatabase'
import { createOverviewCache, type CachedSession } from '../../src/host/overviewCache'
import type { HostSession } from '../../src/host/overviewCorpus'

const TMP_ROOT = resolve('.tmp')

const dirs: string[] = []

function tempDir(): string {
  mkdirSync(TMP_ROOT, { recursive: true })
  const dir = mkdtempSync(join(TMP_ROOT, 'dsh-context-dbc-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function usageOf(uncached: number): SessionCostUsage {
  return { deepseek: { 'deepseek-v4-flash': { off: { uncached, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
}

function sessionOf(id: string, options: { signature?: string; cost?: SessionCostUsage } = {}): HostSession {
  return {
    id,
    title: id,
    updatedAt: 1_000,
    blank: false,
    signature: options.signature ?? 'sig-' + id,
    timeline: {
      current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
      total: 10,
      turns: 1,
      ...(options.cost === undefined ? {} : { cost: options.cost }),
    },
    activity: null,
  }
}

function identityOf(path: string): CachedSession['identity'] {
  const info = statSync(path)
  return { path, sizeBytes: info.size, mtimeMs: info.mtimeMs }
}

function closed(db: OverviewStatsDatabase): void {
  db.close()
}

function stubDatabase(overrides: Partial<OverviewStatsDatabase> = {}): OverviewStatsDatabase {
  const base: OverviewStatsDatabase = {
    path: 'stub',
    available: true,
    revision: 'r1',
    stats: { written: 0, deleted: 0, skipped: 0 },
    get: () => undefined,
    all: () => [],
    load: async () => ({ sessions: new Map(), identities: new Map(), rebuild: new Set() }),
    refresh: async () => ({ identities: new Map(), changed: new Set() }),
    capture: async () => new Map(),
    save: () => {},
    seed: () => {},
    syncRows: () => {},
    flush: () => {},
    close: () => {},
  }
  return Object.assign(base, overrides)
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

describe('dsh-context overview database cache', () => {

  test('serves the cache face from the database and persists across a new cache instance', async () => {
    const dir = tempDir()
    const path = join(dir, 'stats.sqlite')
    const cachePath = join(dir, 'cache.json')
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'abc')
    const identity = identityOf(logPath)
    const cache = createOverviewDatabaseCache({ path, cachePath, debounceMs: 0 })
    assert.ok(cache.database !== null)
    const session = sessionOf('root', { cost: usageOf(10) })
    cache.save([{ session, identity }])
    await cache.flush()
    assert.equal(existsSync(cachePath), false, 'the JSON cache is untouched while the database serves')
    const reopened = createOverviewDatabaseCache({ path, cachePath, debounceMs: 0 })
    const loaded = await reopened.load(new Set(['root']), new Map([['root', identity]]))
    assert.deepEqual(loaded.sessions.get('root'), session)
    assert.equal(loaded.rebuild.size, 0)
    const changed = new Map([['root', { path: logPath, sizeBytes: identity?.sizeBytes ?? 0, mtimeMs: (identity?.mtimeMs ?? 0) + 1 }]])
    const rebuilt = await reopened.load(new Set(['root']), changed)
    assert.deepEqual([...rebuilt.rebuild], ['root'])
    const refreshed = await reopened.refresh(new Set(['root']), new Map([['root', identity]]))
    assert.equal(refreshed.changed.size, 0)
    const captured = await reopened.capture(['root'], { stat: async () => ({ location: { path: logPath }, sizeBytes: identity?.sizeBytes }) })
    assert.deepEqual(captured.get('root'), identity)
    reopened.dispose()
    cache.dispose()
  })

  test('falls back to the JSON cache with normal identity validation when no database opens', async () => {
    const dir = tempDir()
    const cachePath = join(dir, 'cache.json')
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'abc')
    const identity = identityOf(logPath)
    const cache = createOverviewDatabaseCache({ database: null, cachePath, debounceMs: 0 })
    assert.equal(cache.database, null)
    const session = sessionOf('root', { cost: usageOf(5) })
    cache.save([{ session, identity }])
    await cache.flush()
    assert.ok(existsSync(cachePath))
    const reader = createOverviewDatabaseCache({ database: null, cachePath, debounceMs: 0 })
    const matched = await reader.load(new Set(['root']), new Map([['root', identity]]))
    assert.deepEqual(matched.sessions.get('root'), session)
    await writeFile(logPath, 'abcdef')
    const stale = await reader.load(new Set(['root']))
    assert.equal(stale.sessions.size, 0, 'a mismatched identity never serves the stale row')
    assert.deepEqual([...stale.rebuild], ['root'])
    assert.equal(stale.identities.get('root')?.path, logPath)
    reader.dispose()
    cache.dispose()
  })

  test('deactivates on a runtime database failure, then writes through the JSON cache', async () => {
    const dir = tempDir()
    const path = join(dir, 'stats.sqlite')
    const cachePath = join(dir, 'cache.json')
    const db = openOverviewDatabase({ path })
    assert.ok(db !== null)
    closed(db)
    const cache = createOverviewDatabaseCache({ database: db, cachePath, debounceMs: 0 })
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'abc')
    const identity = identityOf(logPath)
    const session = sessionOf('root', { cost: usageOf(7) })
    const loaded = await cache.load(new Set(['root']), new Map([['root', identity]]))
    assert.equal(loaded.sessions.size, 0)
    assert.equal(cache.database, null)
    const captured = await cache.capture([], {})
    assert.equal(captured.size, 0)
    const refreshed = await cache.refresh(new Set(), new Map())
    assert.equal(refreshed.changed.size, 0)
    cache.save([{ session, identity }])
    await cache.flush()
    assert.ok(existsSync(cachePath), 'the fallback JSON cache receives the save')
    const reader = createOverviewDatabaseCache({ database: null, cachePath, debounceMs: 0 })
    const read = await reader.load(new Set(['root']), new Map([['root', identity]]))
    assert.deepEqual(read.sessions.get('root'), session)
    reader.dispose()
    cache.dispose()
  })

  test('a failed database never resurrects older JSON projections with the same log identity', async () => {
    const dir = tempDir()
    const cachePath = join(dir, 'legacy.json')
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'abc')
    const identity = identityOf(logPath)
    const legacy = createOverviewCache({ path: cachePath, debounceMs: 0 })
    legacy.save([{ session: sessionOf('root', { cost: usageOf(1) }), identity }])
    await legacy.flush()
    legacy.dispose()
    const cache = createOverviewDatabaseCache({ path: join(dir, 'stats.sqlite'), cachePath })
    cache.save([{ session: sessionOf('root', { cost: usageOf(99) }), identity }])
    await cache.flush()
    cache.database!.close()
    const recovered = await cache.load(new Set(['root']), new Map([['root', identity]]))
    assert.equal(recovered.sessions.size, 0, 'the caller must rebuild from the authoritative projections')
    assert.deepEqual([...recovered.rebuild], ['root'])
    cache.dispose()
  })

  test('migrates a cold JSON cache into an empty database and seeds rows the database is missing', async () => {
    const dir = tempDir()
    const dataPath = join(dir, 'stats.sqlite')
    const cachePath = join(dir, 'cache.json')
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'abc')
    const identity = identityOf(logPath)
    const session = sessionOf('root', { cost: usageOf(9) })
    const legacy = createOverviewCache({ path: cachePath, debounceMs: 0 })
    legacy.save([{ session, identity }])
    await legacy.flush()
    legacy.dispose()
    const cache = createOverviewDatabaseCache({ path: dataPath, cachePath, debounceMs: 0 })
    const migrated = await cache.load(new Set(['root']), new Map([['root', identity]]))
    assert.deepEqual(migrated.sessions.get('root'), session)
    assert.equal((cache.database?.get('SELECT COUNT(*) AS n FROM cache_session') as { n: number } | undefined)?.n, 1)
    cache.dispose()
    rmSync(cachePath, { force: true })
    const reopened = createOverviewDatabaseCache({ path: dataPath, cachePath, debounceMs: 0 })
    const served = await reopened.load(new Set(['root']), new Map([['root', identity]]))
    assert.deepEqual(served.sessions.get('root'), session, 'the migrated row survives a restart without the JSON file')
    reopened.dispose()
  })

  test('a generation change clears the database and never seeds an older-generation JSON cache', async () => {
    const dir = tempDir()
    const dataPath = join(dir, 'stats.sqlite')
    const cachePath = join(dir, 'cache.json')
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'abc')
    const identity = identityOf(logPath)
    const legacy = createOverviewCache({ path: cachePath, debounceMs: 0 })
    legacy.save([{ session: sessionOf('root', { cost: usageOf(7) }), identity }])
    await legacy.flush()
    legacy.dispose()
    const upgraded = createOverviewDatabaseCache({ path: dataPath, cachePath, debounceMs: 0, generation: '7.42' })
    const loaded = await upgraded.load(new Set(['root']), new Map([['root', identity]]))
    assert.equal(loaded.sessions.size, 0, 'an older file generation is not adopted')
    assert.equal(loaded.identities.size, 0)
    assert.equal((upgraded.database?.get('SELECT COUNT(*) AS n FROM cache_session') as { n: number } | undefined)?.n, 0)
    upgraded.dispose()
  })

  test('a same-generation JSON cache migrates, while a later generation rebuilds over it', async () => {
    const dir = tempDir()
    const dataPath = join(dir, 'stats.sqlite')
    const cachePath = join(dir, 'cache.json')
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'abc')
    const identity = identityOf(logPath)
    const session = sessionOf('root', { cost: usageOf(9) })
    const legacy = createOverviewCache({ path: cachePath, debounceMs: 0, generation: '7.42' })
    legacy.save([{ session, identity }])
    await legacy.flush()
    legacy.dispose()
    const cache = createOverviewDatabaseCache({ path: dataPath, cachePath, debounceMs: 0, generation: '7.42' })
    const migrated = await cache.load(new Set(['root']), new Map([['root', identity]]))
    assert.deepEqual(migrated.sessions.get('root'), session)
    assert.equal((cache.database?.get('SELECT COUNT(*) AS n FROM cache_session') as { n: number } | undefined)?.n, 1)
    cache.dispose()
    const next = createOverviewDatabaseCache({ path: dataPath, cachePath, debounceMs: 0, generation: '7.43' })
    const rebuilt = await next.load(new Set(['root']), new Map([['root', identity]]))
    assert.equal(rebuilt.sessions.size, 0, 'a later generation never serves the previous rows or file')
    assert.equal(rebuilt.identities.size, 0)
    assert.equal((next.database?.get('SELECT COUNT(*) AS n FROM cache_session') as { n: number } | undefined)?.n, 0)
    next.dispose()
  })

  test('the JSON fallback honors the generation when the database is unavailable', async () => {
    const dir = tempDir()
    const cachePath = join(dir, 'cache.json')
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'abc')
    const identity = identityOf(logPath)
    const legacy = createOverviewCache({ path: cachePath, debounceMs: 0 })
    legacy.save([{ session: sessionOf('root'), identity }])
    await legacy.flush()
    legacy.dispose()
    const cache = createOverviewDatabaseCache({ database: null, cachePath, debounceMs: 0, generation: '7.42' })
    const loaded = await cache.load(new Set(['root']), new Map([['root', identity]]))
    assert.equal(loaded.sessions.size, 0, 'the fallback never resurrects an older generation')
    assert.equal(cache.database, null)
    cache.dispose()
  })

  test('seeds only the records the database lacks and never resurrects stale JSON rows', async () => {
    const dir = tempDir()
    const dataPath = join(dir, 'stats.sqlite')
    const cachePath = join(dir, 'cache.json')
    const firstLog = join(dir, 'first.jsonl')
    const secondLog = join(dir, 'second.jsonl')
    writeFileSync(firstLog, 'aaa')
    writeFileSync(secondLog, 'bbb')
    const firstIdentity = identityOf(firstLog)
    const secondIdentity = identityOf(secondLog)
    assert.ok(firstIdentity !== null && secondIdentity !== null)
    const first = sessionOf('first', { cost: usageOf(1) })
    const second = sessionOf('second', { cost: usageOf(2) })
    const legacy = createOverviewCache({ path: cachePath, debounceMs: 0 })
    legacy.save([{ session: first, identity: firstIdentity }, { session: second, identity: secondIdentity }])
    await legacy.flush()
    legacy.dispose()
    const cache = createOverviewDatabaseCache({ path: dataPath, cachePath, debounceMs: 0 })
    cache.save([{ session: first, identity: firstIdentity }])
    await cache.flush()
    const loaded = await cache.load(new Set(['first', 'second']), new Map([['first', firstIdentity], ['second', secondIdentity]]))
    assert.deepEqual(loaded.sessions.get('second'), second)
    assert.equal((cache.database?.get('SELECT COUNT(*) AS n FROM cache_session') as { n: number } | undefined)?.n, 2)
    const stale = sessionOf('stale')
    const staleLegacy = createOverviewCache({ path: join(dir, 'stale.json'), debounceMs: 0 })
    staleLegacy.save([{ session: stale, identity: { ...secondIdentity, mtimeMs: secondIdentity!.mtimeMs + 1 } }])
    await staleLegacy.flush()
    staleLegacy.dispose()
    const staleCache = createOverviewDatabaseCache({ path: join(dir, 'stale.sqlite'), cachePath: join(dir, 'stale.json'), debounceMs: 0 })
    const rejected = await staleCache.load(new Set(['stale']), new Map([['stale', secondIdentity]]))
    assert.equal(rejected.sessions.size, 0)
    assert.deepEqual([...rejected.rebuild], ['stale'])
    assert.equal((staleCache.database?.get('SELECT COUNT(*) AS n FROM cache_session') as { n: number } | undefined)?.n, 0)
    staleCache.dispose()
    cache.dispose()
  })

  test('a failed seed save never fails the load', async () => {
    const dir = tempDir()
    const cachePath = join(dir, 'cache.json')
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'abc')
    const identity = identityOf(logPath)
    const session = sessionOf('root')
    const legacy = createOverviewCache({ path: cachePath, debounceMs: 0 })
    legacy.save([{ session, identity }])
    await legacy.flush()
    legacy.dispose()
    const cache = createOverviewDatabaseCache({
      database: stubDatabase({ seed: () => { throw new Error('seed down') } }),
      cachePath,
      debounceMs: 0,
    })
    const loaded = await cache.load(new Set(['root']), new Map([['root', identity]]))
    assert.deepEqual(loaded.sessions.get('root'), session)
    assert.equal(cache.database, null, 'a failed seed deactivates the store but keeps the validated result')
    cache.dispose()
  })

  test('uses the default database path and debounce, firing the timer on its own', async () => {
    const dir = tempDir()
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    try {
      const logPath = join(dir, 'session.jsonl')
      writeFileSync(logPath, 'abc')
      const identity = identityOf(logPath)
      const cache = createOverviewDatabaseCache({ debounceMs: 5, cachePath: join(dir, 'cache.json') })
      assert.ok(cache.database !== null)
      assert.equal(cache.database.path, join(dir, 'storages', 'dsh-context', 'overview-stats.v1.sqlite'))
      cache.save([{ session: sessionOf('timer'), identity }])
      await sleep(40)
      assert.equal((cache.database.get('SELECT COUNT(*) AS n FROM cache_session') as { n: number } | undefined)?.n, 1)
      cache.dispose()
      const cached = createOverviewDatabaseCache({ debounceMs: 5, cachePath: join(dir, 'cache.json') })
      cached.save([{ session: sessionOf('flush'), identity }])
      await cached.flush()
      cached.dispose()
      const defaulted = createOverviewDatabaseCache({ path: join(dir, 'default.sqlite'), cachePath: join(dir, 'default.json') })
      defaulted.save([{ session: sessionOf('default'), identity }])
      await defaulted.flush()
      defaulted.dispose()
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })

  test('falls back through default options and deactivates on a throwing database stub', async () => {
    const dir = tempDir()
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    try {
      const noDb = createOverviewDatabaseCache({ database: null })
      const loaded = await noDb.load(new Set())
      assert.equal(loaded.sessions.size, 0)
      noDb.dispose()
      let closedStub = 0
      const failing = createOverviewDatabaseCache({
        database: stubDatabase({
          load: async () => { throw new Error('load down') },
          save: () => { throw new Error('save down') },
          close: () => { closedStub++ },
        }),
        cachePath: join(dir, 'fallback.json'),
        debounceMs: 0,
      })
      const missed = await failing.load(new Set())
      assert.equal(missed.sessions.size, 0)
      assert.equal(failing.database, null)
      assert.equal(closedStub, 1)
      failing.save([{ session: sessionOf('fallback'), identity: null }])
      await failing.flush()
      assert.ok(existsSync(join(dir, 'fallback.json')))
      failing.dispose()
      failing.dispose()
      let closedSaves = 0
      const saveFailing = createOverviewDatabaseCache({
        database: stubDatabase({ save: () => { throw new Error('save down') }, close: () => { closedSaves++ } }),
        cachePath: join(dir, 'save-fallback.json'),
        debounceMs: 0,
      })
      saveFailing.save([{ session: sessionOf('saved'), identity: null }])
      await saveFailing.flush()
      assert.equal(saveFailing.database, null)
      assert.equal(closedSaves, 1)
      saveFailing.dispose()
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })

  test('debounces saves, flushes on dispose, and ignores saves after dispose', async () => {
    const dir = tempDir()
    const path = join(dir, 'stats.sqlite')
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'abc')
    const identity = identityOf(logPath)
    const cache: OverviewDatabaseCache = createOverviewDatabaseCache({ path, cachePath: join(dir, 'cache.json'), debounceMs: 5 })
    cache.save([{ session: sessionOf('a'), identity }])
    cache.save([{ session: sessionOf('b'), identity }])
    cache.dispose()
    assert.equal(cache.database, null)
    const reopened = createOverviewDatabaseCache({ path, cachePath: join(dir, 'cache.json'), debounceMs: 0 })
    const loaded = await reopened.load(new Set(['a', 'b']), new Map([['a', identity], ['b', identity]]))
    assert.deepEqual([...loaded.sessions.keys()].sort(), ['b'])
    reopened.dispose()
    cache.save([{ session: sessionOf('c'), identity }])
    await cache.flush()
  })
})
