import { createOverviewCache, type CachedSession, type DurableIdentity, type OverviewCache, type OverviewCacheLoad, type OverviewCacheRefresh, type StatHost } from './overviewCache'
import { openOverviewDatabase, type OverviewStatsDatabase } from './overviewDatabase'

export interface OverviewDatabaseCacheOptions {
  path?: string
  cachePath?: string
  debounceMs?: number
  database?: OverviewStatsDatabase | null
  generation?: string
}

export interface OverviewDatabaseCache extends OverviewCache {
  readonly database: OverviewStatsDatabase | null
}

const DEFAULT_DEBOUNCE_MS = 2_000

export function createOverviewDatabaseCache(options: OverviewDatabaseCacheOptions = {}): OverviewDatabaseCache {
  let database = options.database === undefined
    ? openOverviewDatabase({
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.generation === undefined ? {} : { generation: options.generation }),
    })
    : options.database
  let fallback: OverviewCache | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: CachedSession[] | null = null
  let disposed = false
  let failedDatabase = false
  const fallbackOf = (): OverviewCache => {
    fallback ??= createOverviewCache({
      ...(options.cachePath === undefined ? {} : { path: options.cachePath }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
      ...(options.generation === undefined ? {} : { generation: options.generation }),
    })
    return fallback
  }
  const deactivate = (): void => {
    if (database !== null) {
      failedDatabase = true
      try {
        database.close()
      } catch {}
      database = null
    }
  }
  const apply = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const records = pending
    pending = null
    if (records === null) return
    if (database === null) {
      fallbackOf().save(records)
      return
    }
    try {
      database.save(records)
    } catch {
      deactivate()
      fallbackOf().save(records)
    }
  }
  const guarded = async <T>(run: (db: OverviewStatsDatabase) => Promise<T>, miss: (cache: OverviewCache) => Promise<T>): Promise<T> => {
    const db = database
    if (db === null || !db.available) {
      deactivate()
      return miss(fallbackOf())
    }
    try {
      return await run(db)
    } catch {
      deactivate()
      return miss(fallbackOf())
    }
  }
  const seedFromJson = async (
    db: OverviewStatsDatabase,
    currentIds: ReadonlySet<string>,
    known?: ReadonlyMap<string, DurableIdentity | null>,
  ): Promise<OverviewCacheLoad> => {
    const result = await db.load(currentIds, known)
    const missing = [...currentIds].filter(id => !result.identities.has(id))
    if (missing.length === 0) return result
    const legacy = await fallbackOf().load(new Set(missing), known)
    const records: CachedSession[] = []
    for (const [id, identity] of legacy.identities) {
      const session = legacy.sessions.get(id)
      if (session !== undefined) records.push({ session, identity })
    }
    if (records.length > 0) {
      try {
        db.seed(records)
      } catch {
        deactivate()
      }
    }
    for (const [id, identity] of legacy.identities) result.identities.set(id, identity)
    for (const [id, session] of legacy.sessions) result.sessions.set(id, session)
    for (const id of legacy.rebuild) result.rebuild.add(id)
    return result
  }
  return {
    get database(): OverviewStatsDatabase | null {
      return database
    },
    load(currentIds: ReadonlySet<string>, known?: ReadonlyMap<string, DurableIdentity | null>): Promise<OverviewCacheLoad> {
      return guarded(db => seedFromJson(db, currentIds, known), cache => failedDatabase
        ? Promise.resolve({ sessions: new Map(), identities: new Map(), rebuild: new Set(currentIds) })
        : cache.load(currentIds, known))
    },
    refresh(currentIds: ReadonlySet<string>, known: ReadonlyMap<string, DurableIdentity | null>): Promise<OverviewCacheRefresh> {
      return guarded(db => db.refresh(currentIds, known), cache => cache.refresh(currentIds, known))
    },
    capture(ids: readonly string[], host: StatHost): Promise<Map<string, DurableIdentity | null>> {
      return guarded(db => db.capture(ids, host), cache => cache.capture(ids, host))
    },
    save(records: readonly CachedSession[]): void {
      if (disposed) return
      pending = [...records]
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        apply()
      }, options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
      ;(timer as { unref?: () => void }).unref?.()
    },
    async flush(): Promise<void> {
      apply()
      if (database !== null) database.flush()
      if (fallback !== null) await fallback.flush()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      apply()
      deactivate()
      fallback?.dispose()
    },
  }
}
