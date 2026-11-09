import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { cleanupMounts } from './helpers/kit'
import { advance, fresh, lastOf, mountSummary, stubRoutes, summaryValue } from './helpers/overviewSource'

afterEach(async () => {
  await cleanupMounts()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('overview part guards', () => {
  test('a cached entry of another part never paints for this key', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    mod.cache.writeOverviewPart(
      JSON.stringify({ part: 'summary', scope: { range: 'all' } }),
      { revision: 'r9', pricingReady: true, days: [] },
    )
    const calls = stubRoutes(() => summaryValue({ revision: 'r1' }))
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(lastOf(probe.states).data?.summary.sessions, 2, 'the mismatched cached part is ignored')
    assert.equal(calls[0]?.body.revision, 'r9', 'the known revision still rides the read')
    await probe.m.unmount()
  })

  test('a disabled hook keeps its painted part', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    stubRoutes(() => summaryValue())
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(lastOf(probe.states).data?.summary.sessions, 2)
    await probe.update({ range: 'all' }, false)
    const state = lastOf(probe.states)
    assert.equal(state.data?.summary.sessions, 2, 'the disabled hook keeps the painted part')
    assert.equal(state.pending, false)
    await probe.m.unmount()
  })
})
