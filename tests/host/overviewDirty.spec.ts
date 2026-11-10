import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { boot, call, summaryOf, recordOf, timelineOf, usageOf, dayOf } from './helpers/overview'

const build = vi.hoisted(() => ({ calls: 0, failNext: false }))

vi.mock('../../src/host/overviewCorpus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/overviewCorpus')>()
  return {
    ...actual,
    buildRows: async (...args: Parameters<typeof actual.buildRows>) => {
      build.calls += 1
      if (build.failNext) {
        build.failNext = false
        throw new Error('build broke')
      }
      return actual.buildRows(...args)
    },
  }
})

const PERSISTENCE = {
  stat: async (id: string): Promise<unknown> => ({ header: { id }, location: { path: `/logs/${id}` }, sizeBytes: 10 }),
}

function identityOf(id: string): { path: string; sizeBytes: number; mtimeMs: number } {
  return { path: `/logs/${id}`, sizeBytes: 10, mtimeMs: 5 }
}

function valuesOf(tokens: number): Record<string, unknown> {
  return {
    contextTimeline: timelineOf({ total: tokens * 10, turns: 1, cost: usageOf(tokens, 0, 0, 1) }),
    contextActivity: { days: { '2026-11-01': dayOf(tokens, 1, { turns: 1, cost: usageOf(tokens, 0, 0, 1) }) } },
    title: `Session ${tokens}`,
    sessionListMetadata: { blank: false, lastPromptAt: 1_000 + tokens },
  }
}

describe('overview dirty consumption', () => {
  test('a failed build keeps its folded dirty set so the retry rebuilds the row', async () => {
    build.calls = 0
    build.failNext = false
    const harness = await boot({
      persistence: PERSISTENCE,
      records: [recordOf('a')],
      values: { a: valuesOf(10) },
      scanTtlMs: 10_000,
    })
    harness.state.captureIdentities.set('a', identityOf('a'))
    const warm = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(warm).sessions, 1)
    assert.equal(summaryOf(warm).tokens, 11)
    harness.cacheMode.values.a = valuesOf(99)
    harness.state.foldedVersion = 1
    harness.state.foldedIds = ['a']
    build.failNext = true
    const failed = await call(harness, { part: 'summary' })
    assert.equal(failed.reply.ok, false, 'the failed build fails the request')
    assert.match(failed.reply.error?.message ?? '', /build broke/)
    const retried = await call(harness, { part: 'summary' })
    assert.equal(retried.reply.ok, true)
    assert.equal(summaryOf(retried).tokens, 100, 'the retry rebuilds the folded row instead of reusing it')
    assert.equal(build.calls, 3, 'the warm paint, the failed attempt, and the retry each build once')
    harness.dispose()
  })
})
