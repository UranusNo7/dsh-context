import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import type { OverviewCachedValue } from '../../src/client/overviewCache'
import {
  overviewCacheBytes, overviewCacheSize, readOverviewPart, resetOverviewCache, touchOverviewPart, writeOverviewPart,
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

  test('the five-minute TTL holds a complete response across the old one-minute window', () => {
    assert.equal(ttl, 5 * 60_000)
    writeOverviewPart('a', valueOf('r1'))
    vi.advanceTimersByTime(60_000)
    assert.ok(readOverviewPart('a') !== undefined, 'the entry outlives the previous one-minute TTL')
    vi.advanceTimersByTime(ttl - 60_000)
    assert.equal(readOverviewPart('a'), undefined)
  })

  test('a total byte budget evicts whole entries, never truncating a cached response', () => {
    const budget = policy.maxBytes
    assert.ok(budget !== undefined && budget > 0, 'the overview cache declares a byte budget')
    const pad = 'x'.repeat(400_000)
    const bigOf = (revision: string): OverviewCachedValue => ({ revision, pricingReady: true, days: [], pad } as unknown as OverviewCachedValue)
    for (let index = 0; index < policy.maxEntries; index++) writeOverviewPart(`k${index}`, bigOf(`r${index}`))
    assert.ok(overviewCacheBytes() <= budget, 'the resident bytes stay inside the budget')
    assert.ok(overviewCacheSize() < policy.maxEntries, 'the byte budget trimmed below the entry cap')
    assert.equal(readOverviewPart('k0'), undefined, 'the oldest whole entry made room')
    const last = `k${policy.maxEntries - 1}`
    assert.deepEqual(readOverviewPart(last), bigOf(`r${policy.maxEntries - 1}`), 'a surviving response is returned whole')
  })

  test('the serialized byte budget includes multibyte model and session text', () => {
    const value = valueOf('中文あいう🙂')
    writeOverviewPart('unicode', value)
    assert.equal(overviewCacheBytes(), new TextEncoder().encode(JSON.stringify(value)).byteLength)
    assert.ok(overviewCacheBytes() > JSON.stringify(value).length)
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
