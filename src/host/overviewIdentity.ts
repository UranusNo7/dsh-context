import { optionalNumOf } from './overviewCorpus'
import { asRecord } from './record'

export interface DurableIdentity {
  path: string
  sizeBytes: number
  mtimeMs: number
}

export interface StatHost {
  stat?(id: string): Promise<unknown>
}

export interface DurableStat {
  (path: string): Promise<{ size: number; mtimeMs: number }>
}

export interface IdentityRecord<Session> {
  session: Session
  identity: DurableIdentity | null
}

export interface IdentityLoad<Session> {
  sessions: Map<string, Session>
  identities: Map<string, DurableIdentity | null>
  rebuild: Set<string>
}

export interface IdentityRefresh {
  identities: Map<string, DurableIdentity | null>
  changed: Set<string>
}

export function sameIdentity(left: DurableIdentity | null, right: DurableIdentity | null): boolean {
  if (left === null || right === null) return left === right
  return left.path === right.path && left.sizeBytes === right.sizeBytes && left.mtimeMs === right.mtimeMs
}

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(run))
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

export async function loadIdentityRecords<Session>(
  records: Iterable<readonly [string, IdentityRecord<Session>]>,
  known: ReadonlyMap<string, DurableIdentity | null> | undefined,
  stat: DurableStat,
  concurrency: number,
): Promise<IdentityLoad<Session>> {
  const sessions = new Map<string, Session>()
  const identities = new Map<string, DurableIdentity | null>()
  const rebuild = new Set<string>()
  await inBatches([...records], concurrency, async ([id, record]) => {
    if (known !== undefined) {
      const expected = known.get(id) ?? null
      identities.set(id, expected)
      if (record.identity !== null && sameIdentity(record.identity, expected)) sessions.set(id, record.session)
      else rebuild.add(id)
      return
    }
    if (record.identity === null) {
      identities.set(id, null)
      rebuild.add(id)
      return
    }
    try {
      const info = await stat(record.identity.path)
      if (info.size === record.identity.sizeBytes && info.mtimeMs === record.identity.mtimeMs) {
        identities.set(id, record.identity)
        sessions.set(id, record.session)
        return
      }
      identities.set(id, { path: record.identity.path, sizeBytes: info.size, mtimeMs: info.mtimeMs })
      rebuild.add(id)
    } catch {
      identities.set(id, null)
      rebuild.add(id)
    }
  })
  return { sessions, identities, rebuild }
}

export async function refreshIdentities(
  ids: ReadonlySet<string>,
  known: ReadonlyMap<string, DurableIdentity | null>,
  stat: DurableStat,
  concurrency: number,
): Promise<IdentityRefresh> {
  const identities = new Map<string, DurableIdentity | null>()
  const changed = new Set<string>()
  const targets: { id: string; identity: DurableIdentity }[] = []
  for (const id of ids) {
    const identity = known.get(id)
    if (identity === null || identity === undefined) continue
    targets.push({ id, identity })
  }
  await inBatches(targets, concurrency, async ({ id, identity }) => {
    try {
      const info = await stat(identity.path)
      if (info.size === identity.sizeBytes && info.mtimeMs === identity.mtimeMs) {
        identities.set(id, identity)
        return
      }
      identities.set(id, { path: identity.path, sizeBytes: info.size, mtimeMs: info.mtimeMs })
      changed.add(id)
    } catch {
      identities.set(id, null)
      changed.add(id)
    }
  })
  return { identities, changed }
}

export async function captureIdentities(
  ids: readonly string[],
  host: StatHost,
  stat: DurableStat,
  concurrency: number,
): Promise<Map<string, DurableIdentity | null>> {
  const identities = new Map<string, DurableIdentity | null>()
  const statOf = typeof host.stat === 'function' ? host.stat.bind(host) : undefined
  await inBatches(ids, concurrency, async (id) => {
    identities.set(id, await captureOne(id, statOf, stat))
  })
  return identities
}

async function captureOne(
  id: string,
  statOf: ((id: string) => Promise<unknown>) | undefined,
  stat: DurableStat,
): Promise<DurableIdentity | null> {
  if (statOf === undefined) return null
  let snapshot: unknown
  try {
    snapshot = await statOf(id)
  } catch {
    return null
  }
  const data = asRecord(snapshot)
  const location = asRecord(data?.location)
  const path = typeof location?.path === 'string' && location.path !== '' ? location.path : undefined
  const sizeBytes = optionalNumOf(data?.sizeBytes)
  if (path === undefined || sizeBytes === undefined) return null
  try {
    const info = await stat(path)
    return { path, sizeBytes, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}
