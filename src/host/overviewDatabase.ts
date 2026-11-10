import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ActivityDay, ContextActivity, CostModelUsage, SessionCostUsage } from '../shared/types'
import { tallyTableOf, type CachedSession, type OverviewCacheLoad, type OverviewCacheRefresh } from './overviewCache'
import { numOf, type HostRow, type HostSession } from './overviewCorpus'
import { captureIdentities, loadIdentityRecords, refreshIdentities, sameIdentity, type DurableIdentity, type StatHost } from './overviewIdentity'
import { asRecord } from './record'

export const OVERVIEW_DATABASE_FILE = 'overview-stats.v1.sqlite'

export const OVERVIEW_DATABASE_VERSION = 1

export type SqlValue = string | number | null

export interface OverviewDatabaseRows {
  get(sql: string, params?: readonly SqlValue[]): unknown
  all(sql: string, params?: readonly SqlValue[]): unknown[]
}

export interface OverviewDatabaseStats {
  written: number
  deleted: number
  skipped: number
}

export interface OverviewStatsDatabase extends OverviewDatabaseRows {
  readonly path: string
  readonly available: boolean
  readonly revision: string | null
  readonly stats: OverviewDatabaseStats
  load(currentIds: ReadonlySet<string>, known?: ReadonlyMap<string, DurableIdentity | null>): Promise<OverviewCacheLoad>
  refresh(currentIds: ReadonlySet<string>, known: ReadonlyMap<string, DurableIdentity | null>): Promise<OverviewCacheRefresh>
  capture(ids: readonly string[], host: StatHost): Promise<Map<string, DurableIdentity | null>>
  save(records: readonly CachedSession[]): void
  seed(records: readonly CachedSession[]): void
  syncRows(rows: readonly HostRow[], revision: string): void
  flush(): void
  close(): void
}

export interface OverviewDatabaseOptions {
  path?: string
  generation?: string
}

interface SqliteStatement {
  run(...params: SqlValue[]): unknown
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase
}

const STAT_CONCURRENCY = 4

const LOAD_CHUNK_SIZE = 400

const META_REVISION = 'stats_revision'

const META_GENERATION = 'stats_generation'

const META_OWNER = 'owner'

const OWNER = 'dsh-context'

const SESSION_JSON_COLUMNS = 'id, signature, identity_path, identity_size, identity_mtime, session_json'

const ROOT_COLUMNS = 'root_id, fingerprint, ordinal, updated_at, title_key, cwd_key, last_user_key, archived, running, group_name, tokens, family_turns, context_total, created_day, session_json'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cache_session (
  id TEXT PRIMARY KEY,
  signature TEXT NOT NULL,
  identity_path TEXT,
  identity_size INTEGER,
  identity_mtime REAL,
  session_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS root_row (
  root_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  updated_at REAL NOT NULL,
  title_key TEXT NOT NULL,
  cwd_key TEXT,
  last_user_key TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 0,
  group_name TEXT,
  tokens REAL NOT NULL DEFAULT 0,
  family_turns REAL NOT NULL DEFAULT 0,
  context_total REAL,
  created_day TEXT,
  session_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS root_updated ON root_row (updated_at DESC);
CREATE INDEX IF NOT EXISTS root_tokens ON root_row (tokens DESC);
CREATE INDEX IF NOT EXISTS root_context ON root_row (context_total DESC);
CREATE INDEX IF NOT EXISTS root_archived ON root_row (archived);
CREATE INDEX IF NOT EXISTS root_group ON root_row (group_name);
CREATE TABLE IF NOT EXISTS root_usage (
  root_id TEXT NOT NULL REFERENCES root_row (root_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  period TEXT NOT NULL,
  uncached REAL NOT NULL,
  cache_read REAL NOT NULL,
  cache_write REAL NOT NULL,
  output REAL NOT NULL,
  PRIMARY KEY (root_id, provider, model, period)
);
CREATE TABLE IF NOT EXISTS root_day (
  root_id TEXT NOT NULL REFERENCES root_row (root_id) ON DELETE CASCADE,
  day_key TEXT NOT NULL,
  tokens REAL NOT NULL DEFAULT 0,
  requests REAL NOT NULL DEFAULT 0,
  turns REAL,
  tool_calls REAL,
  tools_ms REAL,
  wall_ms REAL,
  has_skills INTEGER NOT NULL DEFAULT 0,
  tallies_json TEXT,
  PRIMARY KEY (root_id, day_key)
);
CREATE INDEX IF NOT EXISTS root_day_key ON root_day (day_key);
CREATE TABLE IF NOT EXISTS root_day_usage (
  root_id TEXT NOT NULL REFERENCES root_row (root_id) ON DELETE CASCADE,
  day_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  period TEXT NOT NULL,
  uncached REAL NOT NULL,
  cache_read REAL NOT NULL,
  cache_write REAL NOT NULL,
  output REAL NOT NULL,
  PRIMARY KEY (root_id, day_key, provider, model, period)
);
CREATE INDEX IF NOT EXISTS root_day_usage_key ON root_day_usage (day_key, provider, model, period);
`

function sqliteModule(): SqliteModule | null {
  try {
    const require = createRequire(import.meta.url)
    return require('node:sqlite') as SqliteModule
  } catch {
    return null
  }
}

export function overviewDatabasePath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const root = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME
    : join(home, '.dsh')
  return join(root, 'storages', 'dsh-context', OVERVIEW_DATABASE_FILE)
}

function userVersionOf(db: SqliteDatabase): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

function tableCountOf(db: SqliteDatabase): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { n: number }
  return row.n
}

function metaValueOf(db: SqliteDatabase, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: unknown } | undefined
  return typeof row?.value === 'string' ? row.value : null
}

function initializeSchema(db: SqliteDatabase): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(SCHEMA)
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(META_OWNER, OWNER)
    db.exec(`PRAGMA user_version = ${OVERVIEW_DATABASE_VERSION}`)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function applyGeneration(db: SqliteDatabase, generation: string | undefined): void {
  if (generation === undefined || metaValueOf(db, META_GENERATION) === generation) return
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM cache_session').run()
    db.prepare('DELETE FROM meta WHERE key = ?').run(META_REVISION)
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(META_GENERATION, generation)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function openOverviewDatabase(options: OverviewDatabaseOptions = {}): OverviewStatsDatabase | null {
  const sqlite = sqliteModule()
  if (sqlite === null) return null
  const path = options.path ?? overviewDatabasePath()
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try {
      closeSync(openSync(path, 'wx', 0o600))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null
    }
  } catch {
    return null
  }
  let db: SqliteDatabase
  try {
    db = new sqlite.DatabaseSync(path)
  } catch {
    return null
  }
  try {
    const version = userVersionOf(db)
    const owned = version === OVERVIEW_DATABASE_VERSION && metaValueOf(db, META_OWNER) === OWNER
    if (version === 0) {
      if (tableCountOf(db) !== 0) {
        db.close()
        return null
      }
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      db.exec('PRAGMA busy_timeout = 0')
      db.exec('PRAGMA foreign_keys = ON')
      initializeSchema(db)
    } else if (!owned) {
      db.close()
      return null
    } else {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      db.exec('PRAGMA busy_timeout = 0')
      db.exec('PRAGMA foreign_keys = ON')
    }
    applyGeneration(db, options.generation)
  } catch {
    try {
      db.close()
    } catch {}
    return null
  }
  return new StatsDatabase(db, path)
}

type IdentityFields = Pick<CacheSessionDbRow, 'identity_path' | 'identity_size' | 'identity_mtime'>

function identityOfRow(row: IdentityFields): DurableIdentity | null {
  if (row.identity_path === null || row.identity_size === null || row.identity_mtime === null) return null
  return { path: row.identity_path, sizeBytes: row.identity_size, mtimeMs: row.identity_mtime }
}

export function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

export function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}

export interface UsageDbRow {
  provider: string
  model: string
  period: string
  uncached: number
  cache_read: number
  cache_write: number
  output: number
}

export interface RootDayDbRow {
  day_key: string
  tokens: number
  requests: number
  turns: number | null
  tool_calls: number | null
  tools_ms: number | null
  wall_ms: number | null
  has_skills: number
  tallies_json: string | null
}

export interface RootDbRow {
  root_id: string
  updated_at: number
  title_key: string
  cwd_key: string | null
  last_user_key: string | null
  archived: number
  running: number
  group_name: string | null
  tokens: number
  family_turns: number
  context_total: number | null
  created_day: string | null
  session_json: string
}

export function costUsageOfRows(rows: readonly UsageDbRow[]): SessionCostUsage | undefined {
  const usage = Object.create(null) as SessionCostUsage
  let any = false
  for (const row of rows) {
    if (row.period !== 'peak' && row.period !== 'off') continue
    const branch = usage[row.provider] ?? (usage[row.provider] = Object.create(null) as { [model: string]: CostModelUsage })
    const model = branch[row.model] ?? (branch[row.model] = {})
    const previous = model[row.period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    model[row.period] = {
      uncached: previous.uncached + row.uncached,
      cacheRead: previous.cacheRead + row.cache_read,
      cacheWrite: previous.cacheWrite + row.cache_write,
      output: previous.output + row.output,
    }
    any = true
  }
  return any ? usage : undefined
}

function usageRowsOf(cost: SessionCostUsage | null | undefined): UsageDbRow[] {
  if (cost === undefined || cost === null) return []
  const rows: UsageDbRow[] = []
  for (const provider of Object.keys(cost)) {
    const models = asRecord(cost[provider])
    if (models === null) continue
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null) continue
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        rows.push({
          provider,
          model,
          period,
          uncached: numOf(bucket.uncached),
          cache_read: numOf(bucket.cacheRead),
          cache_write: numOf(bucket.cacheWrite),
          output: numOf(bucket.output),
        })
      }
    }
  }
  return rows
}

function talliesJsonOf(day: ActivityDay): string | null {
  if (day.skills === undefined && day.tools === undefined && day.cmds === undefined) return null
  return JSON.stringify({
    ...(day.skills === undefined ? {} : { skills: day.skills }),
    ...(day.tools === undefined ? {} : { tools: day.tools }),
    ...(day.cmds === undefined ? {} : { cmds: day.cmds }),
  })
}

function dayRowsOf(row: HostRow): RootDayDbRow[] {
  const rows: RootDayDbRow[] = []
  const activity = row.activity
  if (activity === null) return rows
  for (const dayKey of Object.keys(activity.days)) {
    const day = activity.days[dayKey]
    rows.push({
      day_key: dayKey,
      tokens: numOf(day.tokens),
      requests: numOf(day.requests),
      turns: day.turns ?? null,
      tool_calls: day.toolCalls ?? null,
      tools_ms: day.toolsMs ?? null,
      wall_ms: day.wallMs ?? null,
      has_skills: day.skills === undefined ? 0 : 1,
      tallies_json: talliesJsonOf(day),
    })
  }
  return rows
}

function dayUsageRowsOf(row: HostRow): (UsageDbRow & { day_key: string })[] {
  const rows: (UsageDbRow & { day_key: string })[] = []
  const activity = row.activity
  if (activity === null) return rows
  for (const dayKey of Object.keys(activity.days)) {
    for (const usage of usageRowsOf(activity.days[dayKey].cost)) rows.push({ ...usage, day_key: dayKey })
  }
  return rows
}

function talliesOf(value: string | null): Pick<ActivityDay, 'skills' | 'tools' | 'cmds'> {
  if (value === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return {}
  }
  const data = asRecord(parsed)
  if (data === null) return {}
  const out: Pick<ActivityDay, 'skills' | 'tools' | 'cmds'> = {}
  for (const field of ['skills', 'tools', 'cmds'] as const) {
    const table = tallyTableOf(data[field])
    if (table !== undefined) out[field] = table
  }
  return out
}

export function activityOfRoot(
  dayRows: readonly RootDayDbRow[],
  usageRows: readonly (UsageDbRow & { day_key: string })[],
): ContextActivity | null {
  if (dayRows.length === 0) return null
  const byDay = new Map<string, UsageDbRow[]>()
  for (const usage of usageRows) {
    const list = byDay.get(usage.day_key) ?? []
    list.push(usage)
    byDay.set(usage.day_key, list)
  }
  const days: Record<string, ActivityDay> = {}
  for (const row of dayRows) {
    const day: ActivityDay = { tokens: row.tokens, requests: row.requests }
    if (row.turns !== null) day.turns = row.turns
    if (row.tool_calls !== null) day.toolCalls = row.tool_calls
    if (row.tools_ms !== null) day.toolsMs = row.tools_ms
    if (row.wall_ms !== null) day.wallMs = row.wall_ms
    const cost = costUsageOfRows(byDay.get(row.day_key) ?? [])
    if (cost !== undefined) day.cost = cost
    Object.assign(day, talliesOf(row.tallies_json))
    days[row.day_key] = day
  }
  return { days }
}

function sessionOfJson(value: string): HostSession {
  return JSON.parse(value) as HostSession
}

function rootFingerprintOf(row: HostRow): string {
  const content = JSON.stringify({
    session: row.session,
    archived: row.archived,
    running: row.running,
    group: row.group ?? null,
    tokens: row.tokens,
    familyTurns: row.family.reduce((sum, member) => sum + (member.timeline?.turns ?? 0), 0),
    createdDay: row.createdDay ?? null,
    usage: usageRowsOf(row.familyCost),
    days: dayRowsOf(row),
    dayUsage: dayUsageRowsOf(row),
  })
  return createHash('sha256').update(content).digest('hex')
}

export interface CacheSessionDbRow {
  id: string
  signature: string
  identity_path: string | null
  identity_size: number | null
  identity_mtime: number | null
  session_json: string
}

export interface ExistingRootRow {
  root_id: string
  fingerprint: string
  ordinal: number
}

class StatsDatabase implements OverviewStatsDatabase {
  readonly stats: OverviewDatabaseStats = { written: 0, deleted: 0, skipped: 0 }
  readonly path: string
  private readonly db: SqliteDatabase
  private committed: string | null
  private closed = false

  constructor(db: SqliteDatabase, path: string) {
    this.db = db
    this.path = path
    this.committed = metaValueOf(db, META_REVISION)
  }

  get revision(): string | null {
    return this.closed ? null : this.committed
  }

  get available(): boolean {
    return !this.closed
  }

  get(sql: string, params: readonly SqlValue[] = []): unknown {
    return this.db.prepare(sql).get(...params)
  }

  all(sql: string, params: readonly SqlValue[] = []): unknown[] {
    return this.db.prepare(sql).all(...params)
  }

  private transaction(run: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      run()
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {}
      throw err
    }
  }

  private cacheRows(ids: readonly string[]): Map<string, CachedSession> {
    const records = new Map<string, CachedSession>()
    for (const chunk of chunksOf(ids, LOAD_CHUNK_SIZE)) {
      const rows = this.all(
        `SELECT ${SESSION_JSON_COLUMNS} FROM cache_session WHERE id IN (${placeholders(chunk.length)})`,
        chunk,
      ) as CacheSessionDbRow[]
      for (const row of rows) records.set(row.id, { session: sessionOfJson(row.session_json), identity: identityOfRow(row) })
    }
    return records
  }

  save(records: readonly CachedSession[]): void {
    this.applyRecords(records, true)
  }

  seed(records: readonly CachedSession[]): void {
    this.applyRecords(records, false)
  }

  private applyRecords(records: readonly CachedSession[], complete: boolean): void {
    if (this.closed) throw new Error('overview database is closed')
    const existing = new Map<string, CacheSessionDbRow>()
    for (const row of this.all(`SELECT ${SESSION_JSON_COLUMNS} FROM cache_session`) as CacheSessionDbRow[]) existing.set(row.id, row)
    const seen = new Set<string>()
    const changed: CachedSession[] = []
    for (const record of records) {
      const id = record.session.id
      if (seen.has(id)) continue
      seen.add(id)
      const previous = existing.get(id)
      if (previous !== undefined && previous.signature === record.session.signature
        && previous.session_json === JSON.stringify(record.session)
        && sameIdentity(identityOfRow(previous), record.identity)) {
        this.stats.skipped++
        continue
      }
      changed.push(record)
    }
    const stale = complete ? [...existing.keys()].filter(id => !seen.has(id)) : []
    const upsert = this.db.prepare(`INSERT INTO cache_session (${SESSION_JSON_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET signature = excluded.signature, identity_path = excluded.identity_path, identity_size = excluded.identity_size, identity_mtime = excluded.identity_mtime, session_json = excluded.session_json`)
    this.transaction(() => {
      for (const record of changed) {
        upsert.run(
          record.session.id,
          record.session.signature,
          record.identity?.path ?? null,
          record.identity?.sizeBytes ?? null,
          record.identity?.mtimeMs ?? null,
          JSON.stringify(record.session),
        )
      }
      for (const chunk of chunksOf(stale, LOAD_CHUNK_SIZE)) {
        this.db.prepare(`DELETE FROM cache_session WHERE id IN (${placeholders(chunk.length)})`).run(...chunk)
      }
    })
    this.stats.written += changed.length
    this.stats.deleted += stale.length
  }

  async load(currentIds: ReadonlySet<string>, known?: ReadonlyMap<string, DurableIdentity | null>): Promise<OverviewCacheLoad> {
    if (this.closed || currentIds.size === 0) return { sessions: new Map(), identities: new Map(), rebuild: new Set() }
    return loadIdentityRecords(this.cacheRows([...currentIds]), known, stat, STAT_CONCURRENCY)
  }

  async refresh(currentIds: ReadonlySet<string>, known: ReadonlyMap<string, DurableIdentity | null>): Promise<OverviewCacheRefresh> {
    return refreshIdentities(currentIds, known, stat, STAT_CONCURRENCY)
  }

  async capture(ids: readonly string[], host: StatHost): Promise<Map<string, DurableIdentity | null>> {
    return captureIdentities(ids, host, stat, STAT_CONCURRENCY)
  }

  syncRows(rows: readonly HostRow[], revision: string): void {
    if (this.closed) throw new Error('overview database is closed')
    const existing = new Map<string, ExistingRootRow>()
    for (const row of this.all('SELECT root_id, fingerprint, ordinal FROM root_row') as ExistingRootRow[]) existing.set(row.root_id, row)
    const seen = new Set<string>()
    const changed: { row: HostRow; fingerprint: string; ordinal: number }[] = []
    const moved: { id: string; ordinal: number }[] = []
    rows.forEach((row, index) => {
      const id = row.session.id
      if (seen.has(id)) return
      seen.add(id)
      const fingerprint = rootFingerprintOf(row)
      const previous = existing.get(id)
      if (previous !== undefined && previous.fingerprint === fingerprint) {
        if (previous.ordinal !== index) moved.push({ id, ordinal: index })
        this.stats.skipped++
        return
      }
      changed.push({ row, fingerprint, ordinal: index })
    })
    const stale = [...existing.keys()].filter(id => !seen.has(id))
    const upsertRoot = this.db.prepare(`INSERT INTO root_row (${ROOT_COLUMNS}) VALUES (${placeholders(15)}) ON CONFLICT (root_id) DO UPDATE SET fingerprint = excluded.fingerprint, ordinal = excluded.ordinal, updated_at = excluded.updated_at, title_key = excluded.title_key, cwd_key = excluded.cwd_key, last_user_key = excluded.last_user_key, archived = excluded.archived, running = excluded.running, group_name = excluded.group_name, tokens = excluded.tokens, family_turns = excluded.family_turns, context_total = excluded.context_total, created_day = excluded.created_day, session_json = excluded.session_json`)
    const deleteUsage = this.db.prepare('DELETE FROM root_usage WHERE root_id = ?')
    const deleteDays = this.db.prepare('DELETE FROM root_day WHERE root_id = ?')
    const deleteDayUsage = this.db.prepare('DELETE FROM root_day_usage WHERE root_id = ?')
    const insertUsage = this.db.prepare('INSERT INTO root_usage (root_id, provider, model, period, uncached, cache_read, cache_write, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const insertDay = this.db.prepare('INSERT INTO root_day (root_id, day_key, tokens, requests, turns, tool_calls, tools_ms, wall_ms, has_skills, tallies_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const insertDayUsage = this.db.prepare('INSERT INTO root_day_usage (root_id, day_key, provider, model, period, uncached, cache_read, cache_write, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const moveRoot = this.db.prepare('UPDATE root_row SET ordinal = ? WHERE root_id = ?')
    this.transaction(() => {
      for (const chunk of chunksOf(stale, LOAD_CHUNK_SIZE)) {
        this.db.prepare(`DELETE FROM root_row WHERE root_id IN (${placeholders(chunk.length)})`).run(...chunk)
      }
      for (const entry of changed) {
        const { row } = entry
        const session = row.session
        deleteUsage.run(session.id)
        deleteDays.run(session.id)
        deleteDayUsage.run(session.id)
        upsertRoot.run(
          session.id,
          entry.fingerprint,
          entry.ordinal,
          session.updatedAt,
          session.title.toLowerCase(),
          session.cwd === undefined ? null : session.cwd.toLowerCase(),
          session.timeline?.lastUser === undefined ? null : session.timeline.lastUser.toLowerCase(),
          row.archived ? 1 : 0,
          row.running ? 1 : 0,
          row.group ?? null,
          row.tokens,
          row.family.reduce((sum, member) => sum + (member.timeline?.turns ?? 0), 0),
          session.timeline?.total ?? null,
          row.createdDay ?? null,
          JSON.stringify(session),
        )
        for (const usage of usageRowsOf(row.familyCost)) {
          insertUsage.run(
            session.id, usage.provider, usage.model, usage.period,
            usage.uncached, usage.cache_read, usage.cache_write, usage.output,
          )
        }
        for (const day of dayRowsOf(row)) {
          insertDay.run(
            session.id, day.day_key, day.tokens, day.requests, day.turns,
            day.tool_calls, day.tools_ms, day.wall_ms, day.has_skills, day.tallies_json,
          )
        }
        for (const usage of dayUsageRowsOf(row)) {
          insertDayUsage.run(
            session.id, usage.day_key, usage.provider, usage.model, usage.period,
            usage.uncached, usage.cache_read, usage.cache_write, usage.output,
          )
        }
      }
      for (const entry of moved) moveRoot.run(entry.ordinal, entry.id)
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(META_REVISION, revision)
    })
    this.committed = revision
    this.stats.written += changed.length
    this.stats.deleted += stale.length
  }

  flush(): void {}

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {}
  }
}
