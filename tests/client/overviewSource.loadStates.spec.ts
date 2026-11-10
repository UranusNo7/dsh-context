import { act } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { cleanupMounts, flush } from './helpers/kit'
import {
  advance, fresh, lastOf, mountSummary, stubFailing, stubManual, stubRoutes, summaryValue,
} from './helpers/overviewSource'

afterEach(async () => {
  await cleanupMounts()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('overview part load states', () => {
  test('the first frame already reports pending, never an empty painted result', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const manual = stubManual()
    const probe = await mountSummary(mod, { range: 'all' })
    const first = lastOf(probe.states)
    assert.equal(first.data, null)
    assert.equal(first.pending, true, 'a request that has not settled reads as loading')
    assert.equal(first.error, false)
    await advance(0)
    assert.equal(manual.calls.length, 1)
    await act(async () => { manual.releases[0]?.(summaryValue()) })
    await flush()
    assert.equal(lastOf(probe.states).pending, false)
    assert.equal(lastOf(probe.states).data?.summary.sessions, 2)
    await probe.m.unmount()
  })

  test('a cached result paints at once and stays marked pending until its background revalidation settles', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    stubRoutes(() => summaryValue())
    const first = await mountSummary(mod, { range: 'all' })
    await advance(0)
    await first.m.unmount()

    stubRoutes(() => ({ revision: 'r1', unchanged: true }))
    const second = await mountSummary(mod, { range: 'all' })
    const restored = lastOf(second.states)
    assert.equal(restored.data?.summary.sessions, 2, 'the cached summary paints before the read lands')
    assert.equal(restored.pending, true, 'the repaint is a background update, not a settled read')
    await advance(0)
    assert.equal(lastOf(second.states).pending, false)
    assert.equal(lastOf(second.states).data?.summary.sessions, 2)
    await second.m.unmount()
  })

  test('a failed refresh keeps the cached result and marks the error', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    stubRoutes(() => summaryValue())
    const first = await mountSummary(mod, { range: 'all' })
    await advance(0)
    await first.m.unmount()

    stubFailing('http')
    const second = await mountSummary(mod, { range: 'all' })
    await advance(0)
    const state = lastOf(second.states)
    assert.equal(state.data?.summary.sessions, 2, 'the last complete result is retained')
    assert.equal(state.error, true, 'the failed update is visible')
    assert.equal(state.stale, true)
    assert.equal(state.pending, false)
    await second.m.unmount()
  })

  test('a failure without any result is an error, not an empty result', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    stubFailing('thrown')
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    const state = lastOf(probe.states)
    assert.equal(state.data, null)
    assert.equal(state.error, true)
    assert.equal(state.pending, false)
    await probe.m.unmount()
  })

  test('a key change clears the previous error as well as the previous data', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    stubFailing('http')
    const probe = await mountSummary(mod, { range: 'today' })
    await advance(0)
    assert.equal(lastOf(probe.states).error, true)
    const manual = stubManual()
    await probe.update({ range: 'all' })
    const switched = lastOf(probe.states)
    assert.equal(switched.data, null, 'the previous query data never shows under the new key')
    assert.equal(switched.error, false, 'the previous query error never shows under the new key')
    assert.equal(switched.pending, true, 'the new key reads as loading from its first frame')
    await advance(0)
    assert.equal(manual.calls.length, 1)
    await act(async () => { manual.releases[0]?.(summaryValue({ revision: 'r2' })) })
    await flush()
    assert.equal(lastOf(probe.states).data?.summary.sessions, 2)
    await probe.m.unmount()
  })
})
