import { act } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import type { OverviewScope } from '../../src/shared/types'
import { retentionOf } from '../../src/client/retention'
import { cleanupMounts, flush } from './helpers/kit'
import {
  advance, fresh, lastOf, mountSummary, OVERVIEW_ROUTE, POLL_MS, stubManual, stubRoutes, summaryRaw,
  summaryValue,
} from './helpers/overviewSource'

afterEach(async () => {
  await cleanupMounts()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('overview part lifecycle', () => {
  test('a remount paints the cached result and confirms it with its own revision', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    stubRoutes(() => summaryValue())
    const first = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(lastOf(first.states).data?.summary.sessions, 2)
    await first.m.unmount()

    const calls = stubRoutes(() => ({ revision: 'r1', unchanged: true }))
    const second = await mountSummary(mod, { range: 'all' })
    assert.equal(lastOf(second.states).data?.summary.sessions, 2, 'the cached summary paints before the read lands')
    await advance(0)
    assert.deepEqual(calls[0]?.body, { part: 'summary', scope: { range: 'all' }, revision: 'r1' })
    assert.equal(lastOf(second.states).data?.summary.sessions, 2, 'the unchanged reply keeps the restored data')
    await advance(POLL_MS)
    assert.equal(calls.length, 2, 'the visible poll still reads')
    assert.equal(calls[1]?.body.revision, 'r1', 'the poll confirms the cached revision')
    assert.equal(lastOf(second.states).data?.summary.sessions, 2)
    await second.m.unmount()
  })

  test('returning to an earlier query restores its own data instead of the other query result', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const calls = stubRoutes((call) => {
      const scope = call.body.scope as OverviewScope
      if (scope.range === 'today') {
        return call.body.revision === 'r1'
          ? { revision: 'r1', unchanged: true }
          : summaryValue({ revision: 'r1', summary: summaryRaw({ sessions: 1 }) })
      }
      return summaryValue({ revision: 'r2', summary: summaryRaw({ sessions: 3 }) })
    })
    const probe = await mountSummary(mod, { range: 'today' })
    await advance(0)
    assert.equal(lastOf(probe.states).data?.summary.sessions, 1)
    await probe.update({ range: 'all' })
    await advance(0)
    assert.equal(lastOf(probe.states).data?.summary.sessions, 3)
    await probe.update({ range: 'today' })
    assert.equal(lastOf(probe.states).data?.summary.sessions, 1, 'the cached query repaints before the read lands')
    await advance(0)
    assert.equal(calls[2]?.body.revision, 'r1', 'the restored query confirms its own revision')
    assert.equal(lastOf(probe.states).data?.summary.sessions, 1, 'the confirmation keeps the restored data')
    assert.equal(calls[1]?.body.revision, null, 'a never-read query always reads cold')
    await probe.m.unmount()
  })

  test('a key change never exposes the previous query data for one frame', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    stubRoutes((call) => summaryValue({
      revision: 'r1',
      summary: summaryRaw({ sessions: (call.body.scope as OverviewScope).range === 'today' ? 1 : 3 }),
    }))
    const probe = await mountSummary(mod, { range: 'today' })
    await advance(0)
    assert.equal(lastOf(probe.states).data?.summary.sessions, 1)
    await probe.update({ range: 'all' })
    assert.equal(lastOf(probe.states).data, null, 'the replaced query data is not exposed under the new key')
    await advance(0)
    assert.equal(lastOf(probe.states).data?.summary.sessions, 3)
    await probe.m.unmount()
  })

  test('a settled replaced request never clears the new request pending flag', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const manual = stubManual()
    const probe = await mountSummary(mod, { range: 'today' })
    await advance(0)
    await probe.update({ range: 'all' })
    await advance(0)
    assert.equal(lastOf(probe.states).pending, true)
    await act(async () => { manual.releases[0]?.(summaryValue({ revision: 'r1', summary: summaryRaw({ sessions: 1 }) })) })
    await flush()
    assert.equal(lastOf(probe.states).pending, true, 'the discarded request leaves the new pending flag alone')
    await act(async () => { manual.releases[1]?.(summaryValue({ revision: 'r2', summary: summaryRaw({ sessions: 3 }) })) })
    await flush()
    assert.equal(lastOf(probe.states).pending, false)
    assert.equal(lastOf(probe.states).data?.summary.sessions, 3)
    await probe.m.unmount()
  })

  test('a late reply of a replaced query never paints over the current one', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const manual = stubManual()
    const probe = await mountSummary(mod, { range: 'today' })
    await advance(0)
    assert.equal(manual.calls.length, 1)
    await probe.update({ range: 'all' })
    await advance(0)
    assert.equal(manual.calls.length, 2)
    await act(async () => { manual.releases[1]?.(summaryValue({ revision: 'r2', summary: summaryRaw({ sessions: 3 }) })) })
    await flush()
    assert.equal(lastOf(probe.states).data?.summary.sessions, 3)
    await act(async () => { manual.releases[0]?.(summaryValue({ revision: 'r1', summary: summaryRaw({ sessions: 1 }) })) })
    await flush()
    assert.equal(lastOf(probe.states).data?.summary.sessions, 3, 'the discarded query reply is dropped')
    const calls = stubRoutes(() => ({ revision: 'r1', unchanged: true }))
    await probe.update({ range: 'today' })
    await advance(0)
    assert.equal(calls[0]?.body.revision, null, 'the dropped reply cached nothing for its query')
    await probe.m.unmount()
  })

  test('an unmounted hook drops its late reply and caches nothing', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const manual = stubManual()
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(manual.calls.length, 1)
    await probe.m.unmount()
    await act(async () => { manual.releases[0]?.(summaryValue()) })
    await flush()
    assert.equal(mod.cache.overviewCacheSize(), 0, 'a dropped reply never enters the result cache')
  })

  test('an expired result makes the next mount read cold', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const ttl = retentionOf('overviewRows').ttlMs ?? 0
    stubRoutes(() => summaryValue())
    const first = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(lastOf(first.states).data?.summary.sessions, 2)
    await first.m.unmount()
    await advance(ttl)
    assert.equal(mod.cache.readOverviewPart(JSON.stringify({ part: 'summary', scope: { range: 'all' } })), undefined, 'the TTL released the result')
    const calls = stubRoutes(() => summaryValue({ revision: 'r2' }))
    const second = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(calls[0]?.body.revision, null, 'an expired result reads cold')
    assert.equal(calls[0]?.route, OVERVIEW_ROUTE)
    assert.equal(lastOf(second.states).data?.summary.sessions, 2)
    await second.m.unmount()
  })

  test('the result cache stays within the retention entry budget', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const max = retentionOf('overviewRows').maxEntries
    stubRoutes(() => summaryValue())
    for (let index = 0; index < max + 1; index++) {
      const probe = await mountSummary(mod, { range: 'all', query: `q${index}` })
      await advance(0)
      await probe.m.unmount()
    }
    assert.equal(mod.cache.overviewCacheSize(), max)
    const calls = stubRoutes(() => ({ revision: 'r1', unchanged: true }))
    const revived = await mountSummary(mod, { range: 'all', query: 'q0' })
    await advance(0)
    assert.equal(calls[0]?.body.revision, null, 'the evicted key reads cold')
    await revived.m.unmount()
  })
})
