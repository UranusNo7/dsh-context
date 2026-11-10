import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createCatalogService } from '../../src/host/catalog'
import { createCostSource } from '../../src/host/cost'
import { boot, call, recordOf, revisionOf, summaryOf, timelineOf, unwrap, usageOf } from './helpers/overview'

const PAYLOAD = { deepseek: { models: {
  'deepseek-v4-flash': { cost: { input: 1, output: 2, cache_read: 0.1 } },
} } }

describe('overview price catalogue recovery', () => {
  test('unchanged polling respects backoff and single-flight, then restores prices without changing the corpus', async () => {
    let now = 1_000_000
    let fetches = 0
    let complete: ((response: Response) => void) | undefined
    const catalog = createCatalogService({
      currentVersion: '0.83.0', now: () => now,
      fetch: async () => {
        fetches++
        if (fetches === 1) throw new Error('offline')
        return new Promise<Response>((resolve) => { complete = resolve })
      },
    })
    const harness = await boot({
      records: [recordOf('a')],
      values: { a: { contextTimeline: timelineOf({ cost: usageOf(1_000_000) }) } },
      costSource: createCostSource(catalog),
    })
    try {
      const request = { part: 'summary', scope: { range: 'all' } }
      const first = await call(harness, request)
      const revision = revisionOf(first)
      assert.equal(summaryOf(first).costUsd, null)
      const firstValue = unwrap(first).value
      assert.ok(firstValue !== undefined && 'pricingReady' in firstValue)
      assert.equal(firstValue.pricingReady, false)
      assert.equal(fetches, 1)
      const poll = { ...request, revision }
      now += 29_999
      assert.deepEqual(unwrap(await call(harness, poll)).value, { revision, unchanged: true })
      assert.equal(fetches, 1)
      now++
      assert.deepEqual(unwrap(await call(harness, poll)).value, { revision, unchanged: true })
      assert.equal(fetches, 2, 'the unchanged path wakes a retry once the failure backoff expires')
      await call(harness, poll)
      assert.equal(fetches, 2, 'concurrent polls share the pending price download')
      complete?.(new Response(JSON.stringify(PAYLOAD)))
      await catalog.prices()
      const recovered = await call(harness, poll)
      assert.notEqual(revisionOf(recovered), revision)
      assert.equal(summaryOf(recovered).costUsd, 1)
      assert.equal(summaryOf(recovered).models?.[0].costUsd, 1)
      assert.equal(summaryOf(recovered).tokens, summaryOf(first).tokens)
      assert.equal(summaryOf(recovered).costSessions, 1)
      assert.deepEqual(unwrap(await call(harness, { ...request, revision: revisionOf(recovered) })).value,
        { revision: revisionOf(recovered), unchanged: true })
      assert.equal(fetches, 2)
    } finally {
      harness.dispose()
      catalog.dispose()
    }
  })
})
