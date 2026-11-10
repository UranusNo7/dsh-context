import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import type { ActivityDay, SessionCostUsage } from '../../src/shared/types'
import { openOverviewDatabase, type OverviewStatsDatabase } from '../../src/host/overviewDatabase'
import { queryDays, queryPage, queryRootUsages } from '../../src/host/overviewDatabaseQuery'
import type { Filters } from '../../src/host/overviewAggregate'
import type { HostRow, HostSession } from '../../src/host/overviewCorpus'

const TMP_ROOT = resolve('.tmp')

const dirs: string[] = []

const openedDbs: OverviewStatsDatabase[] = []

function tempDir(): string {
  mkdirSync(TMP_ROOT, { recursive: true })
  const dir = mkdtempSync(join(TMP_ROOT, 'dsh-context-dbq-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const db of openedDbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function usageOf(uncached: number, cacheRead = 0, cacheWrite = 0, output = 0, period: 'peak' | 'off' = 'off'): SessionCostUsage {
  return { deepseek: { 'deepseek-v4-flash': { [period]: { uncached, cacheRead, cacheWrite, output } } } }
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
        if (bucket !== undefined) total += bucket.uncached + bucket.cacheRead + bucket.cacheWrite + bucket.output
      }
    }
  }
  return total
}

function rowOf(session: HostSession, options: { archived?: boolean; running?: boolean; group?: string; familyCost?: SessionCostUsage | null; family?: HostSession[]; activity?: HostSession['activity']; createdDay?: string } = {}): HostRow {
  const familyCost = options.familyCost !== undefined ? options.familyCost : (session.timeline?.cost ?? null)
  const family = options.family ?? [session]
  return {
    session,
    archived: options.archived ?? false,
    ...(options.group === undefined ? {} : { group: options.group }),
    running: options.running ?? false,
    activity: options.activity !== undefined ? options.activity : session.activity,
    family,
    familyCost,
    tokens: billedOf(familyCost),
    ...(options.createdDay === undefined ? {} : { createdDay: options.createdDay }),
  }
}

function filtersOf(overrides: Partial<Filters> = {}): Filters {
  return { window: { start: null, end: null }, day: null, coverage: 'all', group: null, query: '', pick: null, ...overrides }
}

function opened(rows: readonly HostRow[], revision = 'r1'): { db: OverviewStatsDatabase; dir: string } {
  const dir = tempDir()
  const db = openOverviewDatabase({ path: join(dir, 'stats.sqlite') })
  assert.ok(db !== null)
  openedDbs.push(db)
  db.syncRows(rows, revision)
  return { db, dir }
}

function dayOf(tokens: number, requests: number, options: { cost?: SessionCostUsage; turns?: number; toolCalls?: number; toolsMs?: number; wallMs?: number; skills?: string[] } = {}): ActivityDay {
  return {
    tokens,
    requests,
    ...(options.cost === undefined ? {} : { cost: options.cost }),
    ...(options.turns === undefined ? {} : { turns: options.turns }),
    ...(options.toolCalls === undefined ? {} : { toolCalls: options.toolCalls }),
    ...(options.toolsMs === undefined ? {} : { toolsMs: options.toolsMs }),
    ...(options.wallMs === undefined ? {} : { wallMs: options.wallMs }),
    ...(options.skills === undefined ? {} : { skills: Object.fromEntries(options.skills.map(name => [name, { n: 1, last: 1 }])) }),
  }
}

describe('dsh-context overview database query', () => {

  test('page orders by the requested sort, preserves sync ordinals on ties, and carries a full-lifetime family cost', () => {
    const a = rowOf(sessionOf('a', { updatedAt: 10, title: 'Alpha', total: 50, cost: usageOf(4) }), { group: 'G', createdDay: '2026-11-01' })
    const b = rowOf(sessionOf('b', { updatedAt: 10, title: 'Beta', total: 90, cost: usageOf(30) }), { archived: true, running: true })
    const c = rowOf(sessionOf('c', { updatedAt: 20, title: 'Gamma', total: 10, cost: usageOf(8), days: { '2026-11-02': dayOf(5, 1, { cost: usageOf(5) }) } }))
    const { db } = opened([a, b, c])
    const recent = queryPage(db, 'r1', filtersOf(), 'recent', 0)
    assert.ok(recent !== undefined)
    assert.deepEqual(recent.rows.map(row => row.session.id), ['c', 'a', 'b'])
    assert.equal(recent.total, 3)
    assert.equal(recent.scopedTotal, 3)
    const context = queryPage(db, 'r1', filtersOf(), 'context', 0)
    assert.ok(context !== undefined)
    assert.deepEqual(context.rows.map(row => row.session.id), ['b', 'a', 'c'])
    const tokens = queryPage(db, 'r1', filtersOf(), 'tokens', 0)
    assert.ok(tokens !== undefined)
    assert.deepEqual(tokens.rows.map(row => row.session.id), ['b', 'c', 'a'])
    assert.equal(tokens.rows[0].running, true)
    assert.equal(tokens.rows[0].archived, true)
    db.syncRows([c, b, a], 'r2')
    const moved = queryPage(db, 'r2', filtersOf(), 'recent', 0)
    assert.ok(moved !== undefined)
    assert.deepEqual(moved.rows.map(row => row.session.id), ['c', 'b', 'a'])
    const movedTie = queryPage(db, 'r2', filtersOf(), 'tokens', 0)
    assert.ok(movedTie !== undefined)
    assert.deepEqual(movedTie.rows.map(row => row.session.id), ['b', 'c', 'a'])
    const first = queryPage(db, 'r1', filtersOf(), 'recent', 0)
    assert.equal(first, undefined, 'a stale revision never serves rows')
  })

  test('page filters coverage, group, query text, window, and day with the existing semantics', () => {
    const first = rowOf(sessionOf('a', { updatedAt: 10, title: 'СЕССИЯ 100% Alpha', cwd: 'C:/Work', lastUser: 'Привет' }), { group: 'G' })
    const second = rowOf(sessionOf('b', { updatedAt: 30, title: 'Beta', cost: usageOf(2), days: { '2026-11-01': dayOf(4, 1, { skills: ['s'] }), '2026-11-05': dayOf(0, 0) } }), { archived: true })
    const third = rowOf(sessionOf('c', { updatedAt: 2_000, title: 'OLD', days: { '2026-10-01': dayOf(7, 3) } }))
    const { db } = opened([first, second, third])
    const unicode = queryPage(db, 'r1', filtersOf({ query: 'сессия' }), 'recent', 0)
    assert.ok(unicode !== undefined)
    assert.deepEqual(unicode.rows.map(row => row.session.id), ['a'])
    const literal = queryPage(db, 'r1', filtersOf({ query: '100%' }), 'recent', 0)
    assert.ok(literal !== undefined)
    assert.deepEqual(literal.rows.map(row => row.session.id), ['a'])
    const cwd = queryPage(db, 'r1', filtersOf({ query: 'c:/work' }), 'recent', 0)
    assert.ok(cwd !== undefined)
    assert.deepEqual(cwd.rows.map(row => row.session.id), ['a'])
    const lastUser = queryPage(db, 'r1', filtersOf({ query: 'привет' }), 'recent', 0)
    assert.ok(lastUser !== undefined)
    assert.deepEqual(lastUser.rows.map(row => row.session.id), ['a'])
    const grouped = queryPage(db, 'r1', filtersOf({ group: 'G' }), 'recent', 0)
    assert.ok(grouped !== undefined)
    assert.deepEqual(grouped.rows.map(row => row.session.id), ['a'])
    assert.equal(grouped.total, 1)
    assert.equal(grouped.scopedTotal, 3)
    const ungrouped = queryPage(db, 'r1', filtersOf({ group: '__ungrouped__' }), 'recent', 0)
    assert.ok(ungrouped !== undefined)
    assert.deepEqual(ungrouped.rows.map(row => row.session.id), ['c', 'b'])
    const archived = queryPage(db, 'r1', filtersOf({ coverage: 'archived' }), 'recent', 0)
    assert.ok(archived !== undefined)
    assert.deepEqual(archived.rows.map(row => row.session.id), ['b'])
    const active = queryPage(db, 'r1', filtersOf({ coverage: 'active' }), 'recent', 0)
    assert.ok(active !== undefined)
    assert.deepEqual(active.rows.map(row => row.session.id), ['c', 'a'])
    const windowed = queryPage(db, 'r1', filtersOf({ window: { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 10, 3) } }), 'recent', 0)
    assert.ok(windowed !== undefined)
    assert.deepEqual(windowed.rows.map(row => row.session.id), ['b'])
    const day = queryPage(db, 'r1', filtersOf({ day: '2026-10-01', window: { start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 9, 2) } }), 'recent', 0)
    assert.ok(day !== undefined)
    assert.deepEqual(day.rows.map(row => row.session.id), ['c'])
    const empty = queryPage(db, 'r1', filtersOf({ day: '2026-12-01' }), 'recent', 0)
    assert.ok(empty !== undefined)
    assert.equal(empty.total, 0)
    assert.equal(empty.count, 1)
  })

  test('page paginates twelve rows, clamps the page index, and exposes group/created-day facts', () => {
    const rows = Array.from({ length: 25 }, (_, index) => rowOf(sessionOf('s' + String(index).padStart(2, '0'), { updatedAt: 100 - index }), { group: index % 2 === 0 ? 'even' : 'odd', createdDay: '2026-11-01' }))
    const { db } = opened(rows)
    const first = queryPage(db, 'r1', filtersOf(), 'recent', 0)
    assert.ok(first !== undefined)
    assert.equal(first.rows.length, 12)
    assert.equal(first.count, 3)
    assert.equal(first.rows[0].group, 'even')
    assert.equal(first.rows[0].createdDay, '2026-11-01')
    const last = queryPage(db, 'r1', filtersOf(), 'recent', 9)
    assert.ok(last !== undefined)
    assert.equal(last.index, 2)
    assert.equal(last.rows.length, 1)
    assert.deepEqual(last.rows[0].family.map(member => member.id), [last.rows[0].session.id])
    assert.equal(last.rows[0].familyCost, null)
  })

  test('root usages keep the full lifetime cost for open scope, null for an unpriced root, and safe model names', () => {
    const priced = rowOf(sessionOf('priced', { turns: 2, cost: usageOf(10, 1, 2, 3) }))
    const unpriced = rowOf(sessionOf('unpriced', { turns: 3 }))
    const unsafe = rowOf(sessionOf('unsafe', { turns: 1, cost: JSON.parse('{"__proto__":{"constructor":{"off":{"uncached":4,"cacheRead":0,"cacheWrite":0,"output":1}}}}') as SessionCostUsage }))
    const { db } = opened([priced, unpriced, unsafe])
    const roots = queryRootUsages(db, 'r1', filtersOf())
    assert.ok(roots !== undefined)
    assert.equal(roots[0].usage?.deepseek['deepseek-v4-flash'].off?.uncached, 10)
    assert.equal(roots[0].turns, 2)
    assert.equal(roots[1].usage, null)
    assert.equal(roots[1].turns, 3)
    const safe = roots[2].usage
    assert.ok(safe !== null)
    assert.deepEqual(Object.keys(safe), ['__proto__'])
    const safeBranch = safe['__proto__'] as unknown as { constructor: { off?: { uncached: number } } }
    assert.equal(safeBranch.constructor.off?.uncached, 4)
    assert.equal(({} as Record<string, unknown>).constructor, Object)
  })

  test('root usages accumulate the same model across days and periods inside a window, and follow day scope', () => {
    const usageFirst = usageOf(10, 0, 0, 0, 'off')
    const usageSecond = usageOf(20, 0, 0, 0, 'peak')
    const root = rowOf(sessionOf('root', { days: {
      '2026-11-01': dayOf(10, 1, { cost: usageFirst, turns: 2 }),
      '2026-11-02': dayOf(20, 1, { cost: usageSecond, turns: 3 }),
    } }))
    const outside = rowOf(sessionOf('outside', { updatedAt: 999, days: { '2026-10-01': dayOf(50, 1, { cost: usageOf(50), turns: 1 }) } }))
    const { db } = opened([root, outside])
    const window = queryRootUsages(db, 'r1', filtersOf({ window: { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 10, 3) } }))
    assert.ok(window !== undefined)
    assert.deepEqual(window.map(entry => entry.rootId), ['root'])
    const model = window[0].usage?.deepseek['deepseek-v4-flash']
    assert.equal(model?.off?.uncached, 10)
    assert.equal(model?.peak?.uncached, 20)
    assert.equal(window[0].turns, 5)
    const day = queryRootUsages(db, 'r1', filtersOf({ day: '2026-11-02', window: { start: Date.UTC(2026, 10, 2), end: Date.UTC(2026, 10, 2) } }))
    assert.ok(day !== undefined)
    assert.equal(day[0].usage?.deepseek['deepseek-v4-flash'].peak?.uncached, 20)
    assert.equal(day[0].usage?.deepseek['deepseek-v4-flash'].off, undefined)
    assert.equal(day[0].turns, 3)
    const open = queryRootUsages(db, 'r1', filtersOf())
    assert.ok(open !== undefined)
    assert.equal(open[0].usage, null, 'open scope reads the timeline cost, absent here')
  })

  test('day totals follow coverage, merge family cost, count sessions, and skip empty days', () => {
    const first = rowOf(sessionOf('a', { days: { '2026-11-01': dayOf(10, 1, { cost: usageOf(10) }) } }))
    const second = rowOf(sessionOf('b', { days: { '2026-11-01': dayOf(5, 2, { cost: usageOf(5) }), '2026-11-02': dayOf(0, 0) } }), { archived: true })
    const third = rowOf(sessionOf('c', { days: { '2026-11-01': dayOf(7, 3, { cost: usageOf(7) }) } }))
    const { db } = opened([first, second, third])
    const all = queryDays(db, 'r1', 'all')
    assert.ok(all !== undefined)
    assert.deepEqual(all.map(day => day.key), ['2026-11-01'])
    assert.equal(all[0].tokens, 22)
    assert.equal(all[0].sessions, 3)
    assert.equal(all[0].usage?.deepseek['deepseek-v4-flash'].off?.uncached, 22)
    const active = queryDays(db, 'r1', 'active')
    assert.ok(active !== undefined)
    assert.equal(active[0].tokens, 17)
    assert.equal(active[0].sessions, 2)
    const archived = queryDays(db, 'r1', 'archived')
    assert.ok(archived !== undefined)
    assert.equal(archived[0].tokens, 5)
    assert.equal(queryDays(db, 'old', 'all'), undefined)
  })

  test('open-ended windows keep the existing overlap rule and bounded roots without usage stay null', () => {
    const active = rowOf(sessionOf('active', { updatedAt: Date.UTC(2026, 10, 2), days: { '2026-11-02': dayOf(6, 1, { cost: usageOf(6), turns: 1 }) } }))
    const silent = rowOf(sessionOf('silent', { updatedAt: Date.UTC(2026, 10, 2) }))
    const { db } = opened([active, silent])
    const startOnly = queryPage(db, 'r1', filtersOf({ window: { start: Date.UTC(2026, 10, 1), end: null } }), 'recent', 0)
    assert.ok(startOnly !== undefined)
    assert.deepEqual(startOnly.rows.map(row => row.session.id), ['active', 'silent'])
    const endOnly = queryPage(db, 'r1', filtersOf({ window: { start: null, end: Date.UTC(2026, 10, 3) } }), 'recent', 0)
    assert.ok(endOnly !== undefined)
    assert.deepEqual(endOnly.rows.map(row => row.session.id), ['active', 'silent'])
    const rootsStart = queryRootUsages(db, 'r1', filtersOf({ window: { start: Date.UTC(2026, 10, 1), end: null } }))
    assert.ok(rootsStart !== undefined)
    assert.equal(rootsStart[0].usage?.deepseek['deepseek-v4-flash'].off?.uncached, 6)
    assert.equal(rootsStart[0].turns, 1)
    assert.equal(rootsStart[1].usage, null)
    assert.equal(rootsStart[1].turns, 0)
    const rootsEnd = queryRootUsages(db, 'r1', filtersOf({ window: { start: null, end: Date.UTC(2026, 10, 3) } }))
    assert.ok(rootsEnd !== undefined)
    assert.equal(rootsEnd.length, 2)
  })

  test('day totals without cost keep a null usage instead of zero', () => {
    const day = rowOf(sessionOf('day', { days: { '2026-11-01': dayOf(9, 2, { turns: 4, toolCalls: 1, wallMs: 3, skills: ['s'] }) } }))
    const { db } = opened([day])
    const totals = queryDays(db, 'r1', 'all')
    assert.ok(totals !== undefined)
    assert.deepEqual(totals, [{ key: '2026-11-01', tokens: 9, sessions: 1, usage: null }])
  })

  test('skips invalid stored periods and reads hostile day tallies field by field', () => {
    const root = rowOf(sessionOf('root', { cost: usageOf(3), days: { '2026-11-01': dayOf(4, 1, { cost: usageOf(4), turns: 2, toolCalls: 1, toolsMs: 5, wallMs: 6, skills: ['s'] }) } }))
    const { db } = opened([root])
    db.all("INSERT INTO root_usage (root_id, provider, model, period, uncached, cache_read, cache_write, output) VALUES ('root', 'openai', 'gpt-x', 'bogus', 7, 0, 0, 0)")
    const roots = queryRootUsages(db, 'r1', filtersOf())
    assert.ok(roots !== undefined)
    assert.equal(roots[0].usage?.deepseek['deepseek-v4-flash'].off?.uncached, 3)
    assert.equal(roots[0].usage?.openai, undefined)
    const page = queryPage(db, 'r1', filtersOf(), 'recent', 0)
    assert.ok(page !== undefined)
    const activity = page.rows[0].activity?.days['2026-11-01']
    assert.deepEqual([activity?.tokens, activity?.turns, activity?.toolCalls, activity?.toolsMs, activity?.wallMs], [4, 2, 1, 5, 6])
    assert.deepEqual(activity?.skills, { s: { n: 1, last: 1 } })
    db.all("UPDATE root_day SET tallies_json = 'not json'")
    const broken = queryPage(db, 'r1', filtersOf(), 'recent', 0)
    assert.ok(broken !== undefined)
    assert.equal(broken.rows[0].activity?.days['2026-11-01'].skills, undefined)
    db.all("UPDATE root_day SET tallies_json = 'null'")
    const nulled = queryPage(db, 'r1', filtersOf(), 'recent', 0)
    assert.ok(nulled !== undefined)
    assert.equal(nulled.rows[0].activity?.days['2026-11-01'].tools, undefined)
    db.all("UPDATE root_day SET tallies_json = '{\"skills\":{\"bad\":{}},\"tools\":{}}'")
    const partial = queryPage(db, 'r1', filtersOf(), 'recent', 0)
    assert.ok(partial !== undefined)
    assert.equal(partial.rows[0].activity?.days['2026-11-01'].skills, undefined)
  })

  test('pick, unknown revisions, and empty stores take the explicit fallback', () => {
    const { db } = opened([rowOf(sessionOf('a'))])
    const pick = { field: 'skills' as const, name: 'x' }
    assert.equal(queryPage(db, 'r1', filtersOf({ pick }), 'recent', 0), undefined)
    assert.equal(queryRootUsages(db, 'r1', filtersOf({ pick })), undefined)
    assert.equal(queryPage(db, 'r2', filtersOf(), 'recent', 0), undefined)
    assert.equal(queryRootUsages(db, 'r2', filtersOf()), undefined)
    const emptyDir = tempDir()
    const empty = openOverviewDatabase({ path: join(emptyDir, 'stats.sqlite') })
    assert.ok(empty !== null)
    openedDbs.push(empty)
    empty.syncRows([], 'r0')
    assert.deepEqual(queryRootUsages(empty, 'r0', filtersOf()), [])
    const page = queryPage(empty, 'r0', filtersOf(), 'recent', 0)
    assert.ok(page !== undefined)
    assert.deepEqual(page.rows, [])
    assert.deepEqual(queryDays(empty, 'r0', 'all'), [])
  })
})
