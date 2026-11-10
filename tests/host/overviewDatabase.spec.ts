import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import type { ActivityDay, ContextActivity, SessionCostUsage } from '../../src/shared/types'
import { openOverviewDatabase, overviewDatabasePath, type OverviewStatsDatabase } from '../../src/host/overviewDatabase'
import type { CachedSession } from '../../src/host/overviewCache'
import type { HostRow, HostSession } from '../../src/host/overviewCorpus'

const TMP_ROOT = resolve('.tmp')

const homes: string[] = []

function tempDir(): string {
  mkdirSync(TMP_ROOT, { recursive: true })
  const dir = mkdtempSync(join(TMP_ROOT, 'dsh-context-db-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function usageOf(uncached: number, cacheRead = 0, cacheWrite = 0, output = 0): SessionCostUsage {
  return { deepseek: { 'deepseek-v4-flash': { off: { uncached, cacheRead, cacheWrite, output } } } }
}

function sessionOf(id: string, options: { title?: string; updatedAt?: number; cwd?: string; lastUser?: string; turns?: number; total?: number; signature?: string; cost?: SessionCostUsage; days?: Record<string, ActivityDay> } = {}): HostSession {
  return {
    id,
    title: options.title ?? id,
    updatedAt: options.updatedAt ?? 1_000,
    blank: false,
    signature: options.signature ?? 'sig-' + id,
    timeline: {
      current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: options.total ?? 10 },
      total: options.total ?? 10,
      turns: options.turns ?? 1,
      ...(options.lastUser === undefined ? {} : { lastUser: options.lastUser }),
      ...(options.cost === undefined ? {} : { cost: options.cost }),
    },
    activity: options.days === undefined ? null : { days: options.days },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  }
}

function billedOf(usage: SessionCostUsage | null): number {
  if (usage === null) return 0
  let total = 0
  for (const provider of Object.keys(usage)) {
    for (const model of Object.keys(usage[provider])) {
      for (const period of ['peak', 'off'] as const) {
        const bucket = usage[provider][model][period]
        if (bucket === undefined) continue
        total += bucket.uncached + bucket.cacheRead + bucket.cacheWrite + bucket.output
      }
    }
  }
  return total
}

function rowOf(session: HostSession, options: { archived?: boolean; group?: string; familyCost?: SessionCostUsage | null; family?: HostSession[]; activity?: ContextActivity | null; createdDay?: string; tokens?: number } = {}): HostRow {
  const familyCost = options.familyCost !== undefined ? options.familyCost : (session.timeline?.cost ?? null)
  const family = options.family ?? [session]
  return {
    session,
    archived: options.archived ?? false,
    ...(options.group === undefined ? {} : { group: options.group }),
    running: false,
    activity: options.activity !== undefined ? options.activity : session.activity,
    family,
    familyCost,
    tokens: options.tokens ?? billedOf(familyCost),
    ...(options.createdDay === undefined ? {} : { createdDay: options.createdDay }),
  }
}

function cachedOf(session: HostSession, identity: CachedSession['identity']): CachedSession {
  return { session, identity }
}

function assertOpened(db: OverviewStatsDatabase | null): OverviewStatsDatabase {
  assert.ok(db !== null)
  return db
}

describe('dsh-context overview database', () => {

  test('opens its own file, persists stats across reopen, and commits only the synced revision', () => {
    const dir = tempDir()
    const path = join(dir, 'stats.sqlite')
    const db = assertOpened(openOverviewDatabase({ path }))
    assert.equal(db.path, path)
    assert.equal(db.revision, null)
    db.syncRows([rowOf(sessionOf('root', { cost: usageOf(10, 5, 1, 2) }))], 'r1')
    assert.equal(db.revision, 'r1')
    assert.deepEqual(db.stats, { written: 1, deleted: 0, skipped: 0 })
    assert.equal((db.get('SELECT COUNT(*) AS n FROM root_row') as { n: number } | undefined)?.n, 1)
    assert.equal((db.get('SELECT COUNT(*) AS n FROM root_usage') as { n: number } | undefined)?.n, 1)
    db.close()
    const reopened = assertOpened(openOverviewDatabase({ path }))
    assert.equal(reopened.revision, 'r1')
    assert.equal((reopened.get('SELECT tokens FROM root_row WHERE root_id = ?', ['root']) as { tokens: number } | undefined)?.tokens, 18)
    reopened.close()
  })

  test('skips unchanged roots, rewrites same-signature content changes, follows ordinals, and deletes vanished roots', () => {
    const dir = tempDir()
    const db = assertOpened(openOverviewDatabase({ path: join(dir, 'stats.sqlite') }))
    const first = rowOf(sessionOf('a', { updatedAt: 10, title: 'Alpha', days: { '2026-11-01': { tokens: 5, requests: 1 } } }))
    const second = rowOf(sessionOf('b', { updatedAt: 10, title: 'Beta' }))
    db.syncRows([first, second], 'r1')
    db.syncRows([first, second], 'r2')
    assert.deepEqual(db.stats, { written: 2, deleted: 0, skipped: 2 })
    assert.equal(db.revision, 'r2')
    const changedActivity = rowOf(sessionOf('a', { updatedAt: 10, title: 'Alpha', days: { '2026-11-01': { tokens: 9, requests: 2 } } }))
    db.syncRows([changedActivity, second], 'r3')
    assert.deepEqual(db.stats, { written: 3, deleted: 0, skipped: 3 })
    assert.equal((db.get('SELECT tokens FROM root_day WHERE root_id = ?', ['a']) as { tokens: number } | undefined)?.tokens, 9)
    db.syncRows([second, changedActivity], 'r4')
    assert.deepEqual(db.stats, { written: 3, deleted: 0, skipped: 5 })
    assert.deepEqual((db.all('SELECT root_id FROM root_row ORDER BY ordinal ASC') as { root_id: string }[]).map(row => row.root_id), ['b', 'a'])
    db.syncRows([second], 'r5')
    assert.deepEqual(db.stats, { written: 3, deleted: 1, skipped: 6 })
    db.syncRows([second, second], 'r6')
    assert.deepEqual(db.stats, { written: 3, deleted: 1, skipped: 7 })
    assert.equal((db.get('SELECT COUNT(*) AS n FROM root_row') as { n: number } | undefined)?.n, 1)
    assert.equal((db.get('SELECT COUNT(*) AS n FROM root_day') as { n: number } | undefined)?.n, 0)
    db.close()
  })

  test('refuses foreign, corrupted, unsupported, and unwritable stores without deleting anything', () => {
    const dir = tempDir()
    const foreignPath = join(dir, 'foreign.sqlite')
    const foreign = assertOpened(openOverviewDatabase({ path: foreignPath }))
    foreign.all('DELETE FROM meta')
    foreign.all('PRAGMA user_version = 1')
    foreign.close()
    assert.equal(openOverviewDatabase({ path: foreignPath }), null)
    assert.ok(existsSync(foreignPath), 'a foreign store is left untouched')
    const legacyPath = join(dir, 'legacy.sqlite')
    const legacy = assertOpened(openOverviewDatabase({ path: legacyPath }))
    legacy.all('PRAGMA user_version = 0')
    legacy.close()
    assert.equal(openOverviewDatabase({ path: legacyPath }), null)
    const unsupportedPath = join(dir, 'unsupported.sqlite')
    const unsupported = assertOpened(openOverviewDatabase({ path: unsupportedPath }))
    unsupported.all('PRAGMA user_version = 7')
    unsupported.close()
    assert.equal(openOverviewDatabase({ path: unsupportedPath }), null)
    const corruptPath = join(dir, 'corrupt.sqlite')
    writeFileSync(corruptPath, 'not a database at all')
    assert.equal(openOverviewDatabase({ path: corruptPath }), null)
    assert.ok(existsSync(corruptPath))
    const filePath = join(dir, 'a-file')
    writeFileSync(filePath, 'x')
    assert.equal(openOverviewDatabase({ path: join(filePath, 'nested', 'stats.sqlite') }), null)
    mkdirSync(join(dir, 'as-dir', 'stats.sqlite'), { recursive: true })
    assert.equal(openOverviewDatabase({ path: join(dir, 'as-dir', 'stats.sqlite') }), null)
    assert.equal(openOverviewDatabase({ path: join(dir, 'x'.repeat(300)) }), null)
    const nested = assertOpened(openOverviewDatabase({ path: join(dir, 'nested', 'stats.sqlite') }))
    nested.close()
    assert.ok(existsSync(join(dir, 'nested', 'stats.sqlite')))
  })

  test('rolls back a failed initialization atomically and never leaves a half schema', () => {
    const dir = tempDir()
    const path = join(dir, 'conflict.sqlite')
    const require = createRequire(import.meta.url)
    const sqlite = require('node:sqlite') as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void
        prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown }
        close(): void
      }
    }
    const raw = new sqlite.DatabaseSync(path)
    raw.exec("CREATE VIEW meta AS SELECT 'owner' AS key, 'x' AS value")
    raw.close()
    assert.equal(openOverviewDatabase({ path }), null)
    const check = new sqlite.DatabaseSync(path)
    assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), [])
    assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 0)
    check.close()
    assert.equal(openOverviewDatabase({ path }), null, 'the failed store is never half-adopted')
    rmSync(path, { force: true })
  })

  test('round-trips cached sessions with identity validation, refresh, capture, and incremental saves', async () => {
    const dir = tempDir()
    const db = assertOpened(openOverviewDatabase({ path: join(dir, 'stats.sqlite') }))
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'abc')
    const info = statSync(logPath)
    const identity = { path: logPath, sizeBytes: info.size, mtimeMs: info.mtimeMs }
    const session = sessionOf('root', { cost: usageOf(10), days: { '2026-11-01': { tokens: 4, requests: 1 } } })
    db.save([cachedOf(session, identity)])
    assert.deepEqual(db.stats, { written: 1, deleted: 0, skipped: 0 })
    const known = new Map([['root', identity]])
    const loaded = await db.load(new Set(['root']), known)
    assert.deepEqual(loaded.sessions.get('root'), session)
    assert.equal(loaded.rebuild.size, 0)
    const changed = new Map([['root', { path: logPath, sizeBytes: info.size, mtimeMs: info.mtimeMs + 1 }]])
    const rebuiltDb = await db.load(new Set(['root']), changed)
    assert.equal(rebuiltDb.sessions.size, 0)
    assert.deepEqual([...rebuiltDb.rebuild], ['root'])
    const fromDisk = await db.load(new Set(['root']))
    assert.equal(fromDisk.sessions.size, 1)
    assert.equal(fromDisk.rebuild.size, 0)
    assert.equal(fromDisk.identities.get('root')?.path, logPath)
    const refreshed = await db.refresh(new Set(['root']), known)
    assert.equal(refreshed.changed.size, 0)
    assert.deepEqual(refreshed.identities.get('root'), identity)
    const captured = await db.capture(['root'], { stat: async () => ({ location: { path: logPath }, sizeBytes: info.size }) })
    assert.deepEqual(captured.get('root'), identity)
    await writeFile(logPath, 'abcdef')
    const grown = await db.refresh(new Set(['root']), known)
    assert.deepEqual([...grown.changed], ['root'])
    db.save([cachedOf(sessionOf('other'), null)])
    assert.deepEqual(db.stats, { written: 2, deleted: 1, skipped: 0 })
    assert.equal((db.get('SELECT COUNT(*) AS n FROM cache_session') as { n: number } | undefined)?.n, 1)
    db.close()
  })

  test('rewrites a cached session whose signature and identity stayed the same but whose content changed', async () => {
    const dir = tempDir()
    const path = join(dir, 'stats.sqlite')
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'abc')
    const info = statSync(logPath)
    const identity = { path: logPath, sizeBytes: info.size, mtimeMs: info.mtimeMs }
    const db = assertOpened(openOverviewDatabase({ path }))
    const first = sessionOf('root', { signature: 'same', cost: usageOf(10) })
    db.save([cachedOf(first, identity)])
    const updated = sessionOf('root', { signature: 'same', cost: usageOf(20) })
    db.save([cachedOf(updated, identity)])
    assert.deepEqual(db.stats, { written: 2, deleted: 0, skipped: 0 })
    db.close()
    const reopened = assertOpened(openOverviewDatabase({ path }))
    const loaded = await reopened.load(new Set(['root']), new Map([['root', identity]]))
    assert.deepEqual(loaded.sessions.get('root')?.timeline?.cost, usageOf(20))
    reopened.close()
  })

  test('unknown cache rows read as absent and closed stores reject later work', async () => {
    const dir = tempDir()
    const db = assertOpened(openOverviewDatabase({ path: join(dir, 'stats.sqlite') }))
    const unknown = await db.load(new Set(['missing']))
    assert.equal(unknown.sessions.size, 0)
    assert.equal(unknown.identities.size, 0)
    assert.equal((await db.load(new Set())).sessions.size, 0)
    assert.equal((await db.capture(['id'], {})).get('id'), null)
    assert.equal((await db.capture(['id'], { stat: async () => { throw new Error('down') } })).get('id'), null)
    assert.equal((await db.capture(['id'], { stat: async () => ({ location: { path: join(dir, 'gone') }, sizeBytes: 1 }) })).get('id'), null)
    assert.equal((await db.capture(['id'], { stat: async () => ({ nope: true }) })).get('id'), null)
    const now = await db.refresh(new Set(['id']), new Map())
    assert.equal(now.changed.size, 0)
    db.save([])
    db.flush()
    db.close()
    assert.equal(db.revision, null)
    assert.throws(() => db.save([]), /closed/)
    assert.throws(() => db.syncRows([], 'r'), /closed/)
    db.close()
  })

  test('adopts an empty file, uses the default DSH_HOME path, and keeps a duplicate/unchanged save a no-op', async () => {
    const dir = tempDir()
    const emptyPath = join(dir, 'empty.sqlite')
    writeFileSync(emptyPath, '')
    const adopted = assertOpened(openOverviewDatabase({ path: emptyPath }))
    adopted.close()
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    try {
      const db = assertOpened(openOverviewDatabase())
      assert.equal(db.path, join(dir, 'storages', 'dsh-context', 'overview-stats.v1.sqlite'))
      const session = sessionOf('x')
      db.save([cachedOf(session, null), cachedOf(session, null)])
      assert.deepEqual(db.stats, { written: 1, deleted: 0, skipped: 0 })
      db.save([cachedOf(session, null)])
      assert.deepEqual(db.stats, { written: 1, deleted: 0, skipped: 1 })
      db.close()
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })

  test('degrades hostile family costs, missing timelines, and day tallies field by field', async () => {
    const dir = tempDir()
    const db = assertOpened(openOverviewDatabase({ path: join(dir, 'stats.sqlite') }))
    const bare = { ...sessionOf('child'), timeline: null } as unknown as HostSession
    const root = rowOf(sessionOf('root'), {
      familyCost: { deepseek: 'bad', openai: { model: 'bad', ok: { off: {} } } } as unknown as SessionCostUsage,
      family: [sessionOf('root'), bare],
      tokens: 0,
    })
    const nullTimeline = { ...sessionOf('null-timeline'), timeline: null } as unknown as HostSession
    const tallied = rowOf(sessionOf('tallied'), {
      activity: {
        days: {
          '2026-11-01': {
            tokens: 1,
            requests: 1,
            turns: 2,
            toolCalls: 3,
            toolsMs: 4,
            wallMs: 5,
            skills: { a: { n: 1, last: 1 } },
            tools: { b: { n: 2, last: 2 } },
            cmds: { c: { n: 3, last: 3 } },
          },
          '2026-11-02': { tokens: 1, requests: 1, tools: { b: { n: 2, last: 2 } } },
        },
      },
    })
    db.syncRows([root, rowOf(nullTimeline), tallied], 'r1')
    assert.equal((db.get('SELECT COUNT(*) AS n FROM root_usage') as { n: number } | undefined)?.n, 1)
    assert.equal((db.get("SELECT tokens FROM root_row WHERE root_id = 'null-timeline'") as { tokens: number } | undefined)?.tokens, 0)
    db.all("UPDATE root_day SET tallies_json = 'not json'")
    db.all("UPDATE root_day SET tallies_json = 'null'")
    db.all("UPDATE root_day SET tallies_json = '{\"skills\":{\"bad\":{}},\"tools\":{}}'")
    db.close()
  })

  test('refuses a malformed row inside the sync transaction without committing anything', () => {
    const dir = tempDir()
    const db = assertOpened(openOverviewDatabase({ path: join(dir, 'stats.sqlite') }))
    db.syncRows([rowOf(sessionOf('good'))], 'r1')
    const broken = rowOf(sessionOf('broken'))
    broken.session.title = null as unknown as string
    assert.throws(() => db.syncRows([broken], 'r2'))
    assert.equal(db.revision, 'r1')
    assert.equal((db.get('SELECT COUNT(*) AS n FROM root_row') as { n: number } | undefined)?.n, 1)
    db.syncRows([rowOf(sessionOf('good'))], 'r2')
    assert.equal(db.revision, 'r2')
    db.close()
  })

  test('load and refresh degrade every unreadable identity path', async () => {
    const dir = tempDir()
    const db = assertOpened(openOverviewDatabase({ path: join(dir, 'stats.sqlite') }))
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'abc')
    const info = statSync(logPath)
    db.save([
      cachedOf(sessionOf('no-identity'), null),
      cachedOf(sessionOf('wrong'), { path: logPath, sizeBytes: info.size, mtimeMs: info.mtimeMs + 5 }),
      cachedOf(sessionOf('gone'), { path: join(dir, 'gone.jsonl'), sizeBytes: 1, mtimeMs: 1 }),
    ])
    const known = await db.load(new Set(['ghost', 'no-identity']), new Map([['ghost', null], ['no-identity', null]]))
    assert.equal(known.sessions.size, 0)
    const unknown = await db.load(new Set(['no-identity', 'wrong', 'gone']))
    assert.equal(unknown.sessions.size, 0)
    assert.deepEqual([...unknown.rebuild].sort(), ['gone', 'no-identity', 'wrong'])
    const refreshed = await db.refresh(new Set(['gone']), new Map([['gone', { path: join(dir, 'gone.jsonl'), sizeBytes: 1, mtimeMs: 1 }]]))
    assert.deepEqual([...refreshed.changed], ['gone'])
    db.close()
  })

  test('database path lives beside the JSON cache under DSH_HOME or the home directory', () => {
    assert.equal(overviewDatabasePath({ DSH_HOME: 'C:/data' }, 'C:/home'), join('C:/data', 'storages', 'dsh-context', 'overview-stats.v1.sqlite'))
    assert.equal(overviewDatabasePath({}, 'C:/home'), join('C:/home', '.dsh', 'storages', 'dsh-context', 'overview-stats.v1.sqlite'))
  })

  test('a cache generation discards older derived rows and gates the revision until the next sync', async () => {
    const dir = tempDir()
    const path = join(dir, 'generation.sqlite')
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'abc')
    const info = statSync(logPath)
    const identity = { path: logPath, sizeBytes: info.size, mtimeMs: info.mtimeMs }
    const session = sessionOf('root', { days: { '2026-11-01': { tokens: 4, requests: 1, tools: { run_code: { n: 1, last: 1 } } } } })
    const first = assertOpened(openOverviewDatabase({ path, generation: '6.41' }))
    first.save([cachedOf(session, identity)])
    first.syncRows([rowOf(session)], 'r1')
    first.close()
    const upgraded = assertOpened(openOverviewDatabase({ path, generation: '7.42' }))
    assert.equal(upgraded.revision, null, 'an older generation never serves the stored revision')
    assert.equal((upgraded.get('SELECT COUNT(*) AS n FROM cache_session') as { n: number } | undefined)?.n, 0)
    assert.equal((upgraded.get('SELECT COUNT(*) AS n FROM root_row') as { n: number } | undefined)?.n, 1, 'the rows wait for a sync instead of answering queries')
    const stale = await upgraded.load(new Set(['root']))
    assert.equal(stale.sessions.size, 0)
    assert.equal(stale.rebuild.size, 0)
    const rebuilt = sessionOf('root', { days: { '2026-11-01': { tokens: 4, requests: 1, tools: { read: { n: 1, last: 1 } } } } })
    upgraded.syncRows([rowOf(rebuilt)], 'r2')
    assert.equal(upgraded.revision, 'r2')
    upgraded.close()
    const matched = assertOpened(openOverviewDatabase({ path, generation: '7.42' }))
    assert.equal(matched.revision, 'r2', 'the same generation keeps the committed revision')
    matched.close()
    const unconfigured = assertOpened(openOverviewDatabase({ path }))
    assert.equal(unconfigured.revision, 'r2', 'an unconfigured store is untouched by the gate')
    unconfigured.close()
  })

  test('a failing generation clear rolls back and never adopts the store', () => {
    const dir = tempDir()
    const path = join(dir, 'blocked.sqlite')
    const first = assertOpened(openOverviewDatabase({ path }))
    first.save([cachedOf(sessionOf('root'), null)])
    first.close()
    const require = createRequire(import.meta.url)
    const sqlite = require('node:sqlite') as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void
        prepare(sql: string): { get(...params: unknown[]): unknown }
        close(): void
      }
    }
    const raw = new sqlite.DatabaseSync(path)
    raw.exec("CREATE TRIGGER block_clear BEFORE DELETE ON cache_session BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    raw.close()
    assert.equal(openOverviewDatabase({ path, generation: 'next' }), null)
    const check = new sqlite.DatabaseSync(path)
    assert.equal((check.prepare('SELECT COUNT(*) AS n FROM cache_session').get() as { n: number }).n, 1, 'the clear rolled back')
    check.close()
  })
})
