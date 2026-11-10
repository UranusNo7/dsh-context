import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { boot, call, recordOf, timelineOf, usageOf, dayOf } from './helpers/overview'

const counts = vi.hoisted(() => ({ matches: 0, failSummary: false }))

vi.mock('../../src/host/overviewAggregate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/overviewAggregate')>()
  return {
    ...actual,
    summaryOf: (...args: Parameters<typeof actual.summaryOf>) => {
      if (counts.failSummary) throw new Error('aggregate failed')
      return actual.summaryOf(...args)
    },
    matches: (...args: Parameters<typeof actual.matches>) => {
      counts.matches += 1
      return actual.matches(...args)
    },
  }
})

function valuesOf(tokens: number): Record<string, unknown> {
  return {
    contextTimeline: timelineOf({ total: tokens * 10, turns: 1, cost: usageOf(tokens, 0, 0, 1) }),
    contextActivity: { days: { '2026-11-01': dayOf(tokens, 1, { turns: 1, cost: usageOf(tokens, 0, 0, 1) }) } },
    title: `Session ${tokens}`,
    sessionListMetadata: { blank: false, lastPromptAt: 1_000 + tokens },
  }
}

async function harnessOf(records = 3): Promise<Awaited<ReturnType<typeof boot>>> {
  const ids = ['a', 'b', 'c'].slice(0, records)
  return boot({
    records: ids.map(id => recordOf(id)),
    values: Object.fromEntries(ids.map((id, index) => [id, valuesOf(10 * (index + 1))])),
  })
}

describe('overview per-part row filtering', () => {
  test('an authoritative aggregation failure is reported rather than replaced with empty data', async () => {
    const harness = await harnessOf()
    counts.failSummary = true
    try {
      const result = await call(harness, { part: 'summary' })
      assert.equal(result.reply.ok, false)
      assert.match(result.reply.error?.message ?? '', /aggregate failed/)
    } finally {
      counts.failSummary = false
      harness.dispose()
    }
  })

  const cases: { part: string; tally?: string; expected: number }[] = [
    { part: 'days', expected: 0 },
    { part: 'summary', expected: 3 },
    { part: 'tally', tally: 'tools', expected: 3 },
    { part: 'page', expected: 6 },
  ]
  for (const { part, tally, expected } of cases) {
    test(`a ${part} part runs ${expected} row matches`, async () => {
      const harness = await harnessOf()
      counts.matches = 0
      const reply = await call(harness, tally === undefined ? { part } : { part, tally })
      assert.equal(reply.reply.ok, true)
      assert.equal(counts.matches, expected)
      harness.dispose()
    })
  }
})
