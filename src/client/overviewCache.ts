import type { OverviewUnchanged, OverviewValue } from '../shared/types'
import { makeRetentionCache } from './retention'

export type OverviewCachedValue = Exclude<OverviewValue, OverviewUnchanged>

const parts = makeRetentionCache<string, OverviewCachedValue>('overviewRows')

export function readOverviewPart(key: string): OverviewCachedValue | undefined {
  return parts.get(key)
}

export function writeOverviewPart(key: string, value: OverviewCachedValue): void {
  parts.set(key, value)
}

export function touchOverviewPart(key: string): void {
  const hit = parts.get(key)
  if (hit === undefined) return
  parts.set(key, hit)
}

export function resetOverviewCache(): void {
  parts.clear()
}

export function overviewCacheSize(): number {
  return parts.size
}
