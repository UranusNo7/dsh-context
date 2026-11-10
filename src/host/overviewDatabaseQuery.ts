import { dayKeyOf } from '../shared/days'
import type { OverviewCoverage, OverviewSort, SessionCostUsage } from '../shared/types'
import type { Filters } from './overviewAggregate'
import type { HostRow, HostSession } from './overviewCorpus'
import {
  activityOfRoot,
  chunksOf,
  costUsageOfRows,
  placeholders,
  type OverviewStatsDatabase,
  type RootDayDbRow,
  type RootDbRow,
  type SqlValue,
  type UsageDbRow,
} from './overviewDatabase'

export const DATABASE_PAGE_SIZE = 12

const ID_CHUNK_SIZE = 400

export interface OverviewDatabasePage {
  rows: HostRow[]
  index: number
  count: number
  total: number
  scopedTotal: number
}

export interface OverviewDatabaseRootUsage {
  rootId: string
  usage: SessionCostUsage | null
  turns: number
}

export interface OverviewDatabaseDay {
  key: string
  tokens: number
  sessions: number
  usage: SessionCostUsage | null
}

interface Where {
  sql: string
  params: SqlValue[]
}

interface RootIdRow {
  root_id: string
  family_turns: number
}

interface DayUsageRow extends UsageDbRow {
  day_key: string
}

interface RootUsageRow extends UsageDbRow {
  root_id: string
}

interface RootDayUsageRow extends UsageDbRow {
  root_id: string
  day_key: string
}

const ROOT_SELECT = 'r.root_id, r.updated_at, r.title_key, r.cwd_key, r.last_user_key, r.archived, r.running, r.group_name, r.tokens, r.family_turns, r.context_total, r.created_day, r.session_json'

function coverageWhere(coverage: OverviewCoverage): Where {
  if (coverage === 'all') return { sql: '1 = 1', params: [] }
  return { sql: 'r.archived = ?', params: [coverage === 'archived' ? 1 : 0] }
}

function whereOf(filters: Filters, includeGroup: boolean): Where {
  const parts: string[] = []
  const params: SqlValue[] = []
  if (filters.coverage !== 'all') {
    parts.push('r.archived = ?')
    params.push(filters.coverage === 'archived' ? 1 : 0)
  }
  if (includeGroup && filters.group !== null) {
    if (filters.group === '__ungrouped__') {
      parts.push('r.group_name IS NULL')
    } else {
      parts.push('r.group_name = ?')
      params.push(filters.group)
    }
  }
  if (filters.query !== '') {
    parts.push('(instr(r.title_key, ?) > 0 OR (r.cwd_key IS NOT NULL AND instr(r.cwd_key, ?) > 0) OR (r.last_user_key IS NOT NULL AND instr(r.last_user_key, ?) > 0))')
    params.push(filters.query, filters.query, filters.query)
  }
  const start = filters.window.start
  const end = filters.window.end
  if (start !== null || end !== null) {
    const updated: string[] = []
    if (start !== null) {
      updated.push('r.updated_at >= ?')
      params.push(start)
    }
    if (end !== null) {
      updated.push('r.updated_at <= ?')
      params.push(end)
    }
    const dayParts: string[] = []
    const floor = start === null ? null : dayKeyOf(start)
    const ceiling = end === null ? null : dayKeyOf(end)
    if (floor !== null) {
      dayParts.push('d.day_key >= ?')
      params.push(floor)
    }
    if (ceiling !== null) {
      dayParts.push('d.day_key <= ?')
      params.push(ceiling)
    }
    dayParts.push('(d.tokens > 0 OR d.requests > 0 OR d.turns > 0 OR d.tool_calls > 0 OR d.wall_ms > 0 OR d.has_skills = 1)')
    parts.push(`((${updated.join(' AND ')}) OR EXISTS (SELECT 1 FROM root_day d WHERE d.root_id = r.root_id AND ${dayParts.join(' AND ')}))`)
  }
  if (filters.day !== null) {
    parts.push('EXISTS (SELECT 1 FROM root_day d WHERE d.root_id = r.root_id AND d.day_key = ? AND (d.tokens > 0 OR d.requests > 0))')
    params.push(filters.day)
  }
  return { sql: parts.length === 0 ? '1 = 1' : parts.join(' AND '), params }
}

function admissionOf(filters: Filters): Where {
  const parts: string[] = []
  const params: SqlValue[] = []
  if (filters.day !== null) {
    parts.push('d.day_key = ?')
    params.push(filters.day)
  } else {
    const floor = filters.window.start === null ? null : dayKeyOf(filters.window.start)
    const ceiling = filters.window.end === null ? null : dayKeyOf(filters.window.end)
    if (floor !== null) {
      parts.push('d.day_key >= ?')
      params.push(floor)
    }
    if (ceiling !== null) {
      parts.push('d.day_key <= ?')
      params.push(ceiling)
    }
  }
  return { sql: parts.join(' AND '), params }
}

function sortSqlOf(sort: OverviewSort): string {
  if (sort === 'tokens') return 'r.tokens DESC, r.ordinal ASC'
  if (sort === 'context') return 'COALESCE(r.context_total, -1) DESC, r.ordinal ASC'
  return 'r.updated_at DESC, r.ordinal ASC'
}

function countOf(db: OverviewStatsDatabase, where: Where): number {
  const row = db.get(`SELECT COUNT(*) AS n FROM root_row r WHERE ${where.sql}`, where.params) as { n: number }
  return row.n
}

function usageMapOf(db: OverviewStatsDatabase, ids: readonly string[]): Map<string, UsageDbRow[]> {
  const out = new Map<string, UsageDbRow[]>()
  for (const chunk of chunksOf(ids, ID_CHUNK_SIZE)) {
    const rows = db.all(
      `SELECT root_id, provider, model, period, uncached, cache_read, cache_write, output FROM root_usage WHERE root_id IN (${placeholders(chunk.length)})`,
      chunk,
    ) as RootUsageRow[]
    for (const row of rows) {
      const list = out.get(row.root_id) ?? []
      list.push(row)
      out.set(row.root_id, list)
    }
  }
  return out
}

function dayMapOf(db: OverviewStatsDatabase, ids: readonly string[]): Map<string, RootDayDbRow[]> {
  const out = new Map<string, RootDayDbRow[]>()
  for (const chunk of chunksOf(ids, ID_CHUNK_SIZE)) {
    const rows = db.all(
      `SELECT root_id, day_key, tokens, requests, turns, tool_calls, tools_ms, wall_ms, has_skills, tallies_json FROM root_day WHERE root_id IN (${placeholders(chunk.length)})`,
      chunk,
    ) as (RootDayDbRow & { root_id: string })[]
    for (const row of rows) {
      const list = out.get(row.root_id) ?? []
      list.push(row)
      out.set(row.root_id, list)
    }
  }
  return out
}

function dayUsageMapOf(db: OverviewStatsDatabase, ids: readonly string[]): Map<string, DayUsageRow[]> {
  const out = new Map<string, DayUsageRow[]>()
  for (const chunk of chunksOf(ids, ID_CHUNK_SIZE)) {
    const rows = db.all(
      `SELECT root_id, day_key, provider, model, period, uncached, cache_read, cache_write, output FROM root_day_usage WHERE root_id IN (${placeholders(chunk.length)})`,
      chunk,
    ) as RootDayUsageRow[]
    for (const row of rows) {
      const list = out.get(row.root_id) ?? []
      list.push(row)
      out.set(row.root_id, list)
    }
  }
  return out
}

function hostRowOf(
  row: RootDbRow,
  usage: readonly UsageDbRow[],
  days: readonly RootDayDbRow[],
  dayUsage: readonly DayUsageRow[],
): HostRow {
  const session = JSON.parse(row.session_json) as HostSession
  const hostRow: HostRow = {
    session,
    archived: row.archived === 1,
    running: row.running === 1,
    activity: activityOfRoot(days, dayUsage),
    family: [session],
    familyCost: costUsageOfRows(usage) ?? null,
    tokens: row.tokens,
  }
  if (row.group_name !== null) hostRow.group = row.group_name
  if (row.created_day !== null) hostRow.createdDay = row.created_day
  return hostRow
}

export function queryPage(
  db: OverviewStatsDatabase,
  revision: string,
  filters: Filters,
  sort: OverviewSort,
  page: number,
): OverviewDatabasePage | undefined {
  if (db.revision !== revision || filters.pick !== null) return undefined
  const full = whereOf(filters, true)
  const scoped = whereOf(filters, false)
  const total = countOf(db, full)
  const scopedTotal = countOf(db, scoped)
  if (total === 0) return { rows: [], index: 0, count: 1, total: 0, scopedTotal }
  const pages = Math.max(1, Math.ceil(total / DATABASE_PAGE_SIZE))
  const index = Math.min(Math.max(0, page), pages - 1)
  const rows = db.all(
    `SELECT ${ROOT_SELECT} FROM root_row r WHERE ${full.sql} ORDER BY ${sortSqlOf(sort)} LIMIT ? OFFSET ?`,
    [...full.params, DATABASE_PAGE_SIZE, index * DATABASE_PAGE_SIZE],
  ) as RootDbRow[]
  const ids = rows.map(row => row.root_id)
  const usage = usageMapOf(db, ids)
  const days = dayMapOf(db, ids)
  const dayUsage = dayUsageMapOf(db, ids)
  return {
    rows: rows.map(row => hostRowOf(
      row,
      usage.get(row.root_id) ?? [],
      days.get(row.root_id) ?? [],
      dayUsage.get(row.root_id) ?? [],
    )),
    index,
    count: pages,
    total,
    scopedTotal,
  }
}

export function queryRootUsages(
  db: OverviewStatsDatabase,
  revision: string,
  filters: Filters,
): OverviewDatabaseRootUsage[] | undefined {
  if (db.revision !== revision || filters.pick !== null) return undefined
  const where = whereOf(filters, true)
  const roots = db.all(
    `SELECT r.root_id, r.family_turns FROM root_row r WHERE ${where.sql} ORDER BY r.ordinal ASC`,
    where.params,
  ) as RootIdRow[]
  if (roots.length === 0) return []
  const open = filters.day === null && filters.window.start === null && filters.window.end === null
  if (open) {
    const usage = usageMapOf(db, roots.map(root => root.root_id))
    return roots.map(root => ({
      rootId: root.root_id,
      usage: costUsageOfRows(usage.get(root.root_id) ?? []) ?? null,
      turns: root.family_turns,
    }))
  }
  const admission = admissionOf(filters)
  const turns = new Map<string, number>()
  const usage = new Map<string, UsageDbRow[]>()
  for (const chunk of chunksOf(roots.map(root => root.root_id), ID_CHUNK_SIZE)) {
    const ids = placeholders(chunk.length)
    const turnRows = db.all(
      `SELECT d.root_id, SUM(COALESCE(d.turns, 0)) AS turns FROM root_day d WHERE (${admission.sql}) AND d.root_id IN (${ids}) GROUP BY d.root_id`,
      [...admission.params, ...chunk],
    ) as { root_id: string; turns: number }[]
    for (const row of turnRows) turns.set(row.root_id, row.turns)
    const usageRows = db.all(
      'SELECT u.root_id, u.provider, u.model, u.period, u.uncached, u.cache_read, u.cache_write, u.output '
      + `FROM root_day_usage u JOIN root_day d ON d.root_id = u.root_id AND d.day_key = u.day_key WHERE (${admission.sql}) AND d.root_id IN (${ids})`,
      [...admission.params, ...chunk],
    ) as RootUsageRow[]
    for (const row of usageRows) {
      const list = usage.get(row.root_id) ?? []
      list.push(row)
      usage.set(row.root_id, list)
    }
  }
  return roots.map(root => ({
    rootId: root.root_id,
    usage: costUsageOfRows(usage.get(root.root_id) ?? []) ?? null,
    turns: turns.get(root.root_id) ?? 0,
  }))
}

export function queryDays(
  db: OverviewStatsDatabase,
  revision: string,
  coverage: OverviewCoverage,
): OverviewDatabaseDay[] | undefined {
  if (db.revision !== revision) return undefined
  const where = coverageWhere(coverage)
  const scope = `(${where.sql}) AND (d.tokens > 0 OR d.requests > 0)`
  const totals = db.all(
    'SELECT d.day_key AS key, SUM(d.tokens) AS tokens, COUNT(*) AS sessions '
    + `FROM root_day d JOIN root_row r ON r.root_id = d.root_id WHERE ${scope} GROUP BY d.day_key ORDER BY d.day_key ASC`,
    where.params,
  ) as { key: string; tokens: number; sessions: number }[]
  const usageByDay = new Map<string, UsageDbRow[]>()
  const usageRows = db.all(
    'SELECT d.day_key, u.provider, u.model, u.period, SUM(u.uncached) AS uncached, '
    + 'SUM(u.cache_read) AS cache_read, SUM(u.cache_write) AS cache_write, SUM(u.output) AS output '
    + 'FROM root_day_usage u JOIN root_day d ON d.root_id = u.root_id AND d.day_key = u.day_key '
    + `JOIN root_row r ON r.root_id = d.root_id WHERE ${scope} `
    + 'GROUP BY d.day_key, u.provider, u.model, u.period',
    where.params,
  ) as DayUsageRow[]
  for (const row of usageRows) {
    const list = usageByDay.get(row.day_key) ?? []
    list.push(row)
    usageByDay.set(row.day_key, list)
  }
  return totals.map(row => ({
    key: row.key,
    tokens: row.tokens,
    sessions: row.sessions,
    usage: costUsageOfRows(usageByDay.get(row.key) ?? []) ?? null,
  }))
}
