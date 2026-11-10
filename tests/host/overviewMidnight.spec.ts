import assert from 'node:assert/strict'
import { join } from 'node:path'
import { afterEach, describe, test, vi } from 'vitest'
import {
  boot, call, dayOf, overviewTempDir, recordOf, revisionOf, summaryOf, timelineOf, unwrap, usageOf,
  type BootOptions,
} from './helpers/overview'

afterEach(() => { vi.useRealTimers() })

const LATE_NIGHT = new Date(2026, 10, 8, 23, 59, 50).getTime()

const AFTER_MIDNIGHT = new Date(2026, 10, 9, 0, 0, 20).getTime()

const ABSOLUTE = {
  start: new Date(2026, 10, 8, 0, 0, 0).getTime(),
  end: new Date(2026, 10, 8, 23, 59, 59).getTime(),
}

function corpus(extra: BootOptions = {}): BootOptions {
  return {
    records: [recordOf('a', { createdAt: new Date(2026, 10, 8, 20, 0, 0).getTime() })],
    values: {
      a: {
        contextTimeline: timelineOf({ total: 900, turns: 1, cost: usageOf(900) }),
        contextActivity: { days: { '2026-11-08': dayOf(900, 1) } },
        title: 'Overnight',
        sessionListMetadata: { blank: false, lastPromptAt: new Date(2026, 10, 8, 23, 0, 0).getTime() },
      },
    },
    ...extra,
  }
}

function clock(ms: number): void {
  vi.setSystemTime(ms)
}

function coreOf(summary: ReturnType<typeof summaryOf>): {
  sessions: number
  sessionsTotal: number
  tokens: number
  turns: number
  costSessions: number
  usageSessions: number
} {
  return {
    sessions: summary.sessions,
    sessionsTotal: summary.sessionsTotal,
    tokens: summary.tokens,
    turns: summary.turns,
    costSessions: summary.costSessions,
    usageSessions: summary.usageSessions,
  }
}

describe('overview midnight refresh', () => {
  test('relative ranges re-serve the new local day and stay unchanged afterwards', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const harness = await boot(corpus())
    try {
      for (const range of ['today', '7d', '30d'] as const) {
        clock(LATE_NIGHT)
        const before = await call(harness, { part: 'summary', scope: { range } })
        assert.equal(summaryOf(before).sessions, 1, `${range} counts the overnight session`)
        clock(AFTER_MIDNIGHT)
        const after = unwrap(await call(harness, { part: 'summary', scope: { range }, revision: revisionOf(before) }))
        assert.ok(after.value !== undefined && 'summary' in after.value, `${range} re-serves after midnight`)
        assert.equal(after.value.summary.sessions, range === 'today' ? 0 : 1, `${range} resolves the new window`)
        const steady = unwrap(await call(harness, { part: 'summary', scope: { range }, revision: after.value.revision }))
        assert.ok(steady.value !== undefined && 'unchanged' in steady.value, `${range} stays unchanged on the new day`)
      }
    } finally {
      harness.dispose()
    }
  })

  test('absolute ranges and all stay unchanged across local midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const harness = await boot(corpus())
    try {
      for (const scope of [{ range: ABSOLUTE }, { range: 'all' }] as const) {
        clock(LATE_NIGHT)
        const before = await call(harness, { part: 'summary', scope })
        clock(AFTER_MIDNIGHT)
        const after = unwrap(await call(harness, { part: 'summary', scope, revision: revisionOf(before) }))
        assert.ok(after.value !== undefined && 'unchanged' in after.value, `${JSON.stringify(scope)} stays unchanged`)
      }
    } finally {
      harness.dispose()
    }
  })

  test('a clock beyond the day-key range answers with an open relative window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(10_000, 0, 1))
    const harness = await boot({ records: [], values: {} })
    try {
      const reply = unwrap(await call(harness, { part: 'summary', scope: { range: 'today' } }))
      assert.ok(reply.value !== undefined && 'summary' in reply.value)
      assert.equal(reply.value.summary.sessions, 0)
    } finally {
      harness.dispose()
    }
  })

  test('the indexed SQL path matches the JavaScript path across the midnight flip', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const dir = overviewTempDir()
    const js = await boot(corpus({ noCache: true, cachePath: join(dir, 'js-cache.json') }))
    const db = await boot(corpus({ noCache: true, cachePath: join(dir, 'db-cache.json'), databasePath: join(dir, 'stats.sqlite') }))
    try {
      clock(LATE_NIGHT)
      const jsBefore = await call(js, { part: 'summary', scope: { range: 'today' } })
      const dbBefore = await call(db, { part: 'summary', scope: { range: 'today' } })
      assert.equal(summaryOf(jsBefore).sessions, 1)
      assert.deepEqual(coreOf(summaryOf(dbBefore)), coreOf(summaryOf(jsBefore)), 'both paths agree before midnight')
      clock(AFTER_MIDNIGHT)
      const jsAfter = unwrap(await call(js, { part: 'summary', scope: { range: 'today' }, revision: revisionOf(jsBefore) }))
      const dbAfter = unwrap(await call(db, { part: 'summary', scope: { range: 'today' }, revision: revisionOf(dbBefore) }))
      assert.ok(jsAfter.value !== undefined && 'summary' in jsAfter.value, 'the JavaScript path re-serves the new day')
      assert.ok(dbAfter.value !== undefined && 'summary' in dbAfter.value, 'the SQL path re-serves the new day')
      assert.deepEqual(coreOf(dbAfter.value.summary), coreOf(jsAfter.value.summary), 'both paths agree after midnight')
      assert.equal(dbAfter.value.summary.sessions, 0)
      const jsSteady = unwrap(await call(js, { part: 'summary', scope: { range: 'today' }, revision: jsAfter.value.revision }))
      const dbSteady = unwrap(await call(db, { part: 'summary', scope: { range: 'today' }, revision: dbAfter.value.revision }))
      assert.ok(jsSteady.value !== undefined && 'unchanged' in jsSteady.value)
      assert.ok(dbSteady.value !== undefined && 'unchanged' in dbSteady.value)
    } finally {
      js.dispose()
      db.dispose()
    }
  })
})
