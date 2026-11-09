import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import type { OverviewCachedValue } from '../../src/client/overviewCache'
import {
  overviewCacheSize, readOverviewPart, resetOverviewCache, touchOverviewPart, writeOverviewPart,
} from '../../src/client/overviewCache'
import { retentionOf } from '../../src/client/retention'

const policy = retentionOf('overviewRows')

const ttl = policy.ttlMs ?? 0

function valueOf(revision: string): OverviewCachedValue {
  return { revision, pricingReady: true, days: [] }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetOverviewCache()
})

afterEach(() => {
  resetOverviewCache()
  vi.useRealTimers()
})

describe('overview result cache', () => {
  test('keeps the full response with its revision', () => {
    writeOverviewPart('a', valueOf('r1'))
    const hit = readOverviewPart('a')
    assert.deepEqual(hit, { revision: 'r1', pricingReady: true, days: [] })
    assert.equal(readOverviewPart('missing'), undefined)
  })

  test('expires an entry after the retention TTL without a later read', () => {
    writeOverviewPart('a', valueOf('r1'))
    vi.advanceTimersByTime(ttl - 1)
    assert.ok(readOverviewPart('a') !== undefined, 'the entry lives until the TTL')
    vi.advanceTimersByTime(1)
    assert.equal(readOverviewPart('a'), undefined, 'the TTL timer releases the entry')
    assert.equal(overviewCacheSize(), 0)
  })

  test('touch re-arms the TTL of a mounted key', () => {
    writeOverviewPart('a', valueOf('r1'))
    vi.advanceTimersByTime(ttl - 1)
    touchOverviewPart('a')
    vi.advanceTimersByTime(ttl - 1)
    assert.ok(readOverviewPart('a') !== undefined, 'the touched entry outlives the first TTL')
    vi.advanceTimersByTime(ttl)
    assert.equal(readOverviewPart('a'), undefined)
    touchOverviewPart('missing')
  })

  test('keeps at most the retention entry budget and drops the oldest key', () => {
    const keys = Array.from({ length: policy.maxEntries }, (_, index) => `k${index}`)
    for (const key of keys) writeOverviewPart(key, valueOf('r1'))
    assert.equal(overviewCacheSize(), policy.maxEntries)
    writeOverviewPart('fresh', valueOf('r1'))
    assert.equal(overviewCacheSize(), policy.maxEntries)
    assert.equal(readOverviewPart('k0'), undefined, 'the oldest entry made room')
    assert.ok(readOverviewPart('fresh') !== undefined)
  })

  test('a read makes its key the most recent one', () => {
    const keys = Array.from({ length: policy.maxEntries }, (_, index) => `k${index}`)
    for (const key of keys) writeOverviewPart(key, valueOf('r1'))
    readOverviewPart('k0')
    writeOverviewPart('fresh', valueOf('r1'))
    assert.ok(readOverviewPart('k0') !== undefined, 'the recently read key survives')
    assert.equal(readOverviewPart('k1'), undefined, 'the next oldest entry made room')
  })

  test('reset clears every entry', () => {
    writeOverviewPart('a', valueOf('r1'))
    writeOverviewPart('b', valueOf('r2'))
    resetOverviewCache()
    assert.equal(overviewCacheSize(), 0)
    assert.equal(readOverviewPart('a'), undefined)
  })
})
