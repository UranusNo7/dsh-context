import assert from 'node:assert/strict'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import { openOverviewDatabase } from '../../src/host/overviewDatabase'
import { createOverviewDatabaseCache } from '../../src/host/overviewDatabaseCache'
import type { TimingTotals } from '../../src/shared/types'
import {
  boot, call, dayOf, overviewTempDir, recordOf, summaryOf, tallyOf, timelineOf, usageOf, type Harness,
} from './helpers/overview'

const DAY = '2026-11-01'

const OLD_GENERATION = '6.41'

const NEW_GENERATION = '7.42'

function valuesOf(tokens: number, generation: 'old' | 'new'): Record<string, unknown> {
  const timing: TimingTotals = generation === 'old'
    ? { wallMs: 1_000, ttftMs: 0, genMs: 0, calls: 1, toolsMs: 4_000, toolBusyMs: 0, toolCalls: 1, tools: { run_code: { calls: 1, ms: 4_000 } } }
    : { wallMs: 1_000, ttftMs: 0, genMs: 0, calls: 1, toolsMs: 1_500, toolBusyMs: 0, toolCalls: 1, tools: { read: { calls: 1, ms: 1_500 } } }
  const day = generation === 'old'
    ? dayOf(tokens, 1, { turns: 1, cost: usageOf(tokens), toolCalls: 1, tools: ['run_code'], cmds: ['node'] })
    : dayOf(tokens, 1, { turns: 1, cost: usageOf(tokens), toolCalls: 1, skills: ['tdd'], tools: ['read'] })
  return {
    contextTimeline: timelineOf({ total: tokens * 10, turns: 1, cost: usageOf(tokens), timing }),
    contextActivity: { days: { [DAY]: day } },
    title: `Session ${tokens}`,
    sessionListMetadata: { blank: false, lastPromptAt: 1_000 },
  }
}

function valuesMap(generation: 'old' | 'new'): Record<string, Record<string, unknown>> {
  return { a: valuesOf(10, generation), b: valuesOf(20, generation) }
}

function persistenceOf(dir: string): { stat: (id: string) => Promise<unknown> } {
  return {
    stat: async (id) => {
      const path = join(dir, `${id}.jsonl`)
      const info = statSync(path)
      return { header: { id, createdAt: 1, cwd: `/repo/${id}`, isSeeded: false }, location: { path }, sizeBytes: info.size }
    },
  }
}

interface Storage {
  logDir: string
  databasePath: string
  cachePath: string
}

function storage(): Storage {
  const dir = overviewTempDir()
  const logDir = join(dir, 'logs')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(join(logDir, 'a.jsonl'), 'a')
  writeFileSync(join(logDir, 'b.jsonl'), 'b')
  return { logDir, databasePath: join(dir, 'stats.sqlite'), cachePath: join(dir, 'cache.json') }
}

function bootWithCache(target: Storage, generation: string, values: Record<string, Record<string, unknown>>): Promise<{ harness: Harness; cache: ReturnType<typeof createOverviewDatabaseCache> }> {
  const cache = createOverviewDatabaseCache({
    path: target.databasePath,
    cachePath: target.cachePath,
    debounceMs: 0,
    generation,
  })
  return boot({ persistence: persistenceOf(target.logDir), records: [recordOf('a'), recordOf('b')], values, cache })
    .then(harness => ({ harness, cache }))
}

function bootWithRoutes(target: Storage, values: Record<string, Record<string, unknown>>): Promise<Harness> {
  return boot({
    persistence: persistenceOf(target.logDir),
    records: [recordOf('a'), recordOf('b')],
    values,
    noCache: true,
    databasePath: target.databasePath,
    cachePath: target.cachePath,
  })
}

async function seedOldGeneration(target: Storage): Promise<void> {
  const old = await bootWithCache(target, OLD_GENERATION, valuesMap('old'))
  try {
    const summary = summaryOf(await call(old.harness, { part: 'summary' }))
    assert.deepEqual(summary.timing?.tools, { run_code: { calls: 2, ms: 8_000 } }, 'the old ledger books the transport envelope')
    assert.deepEqual(tallyOf(await call(old.harness, { part: 'tally', tally: 'tools' })).stats.map(stat => stat.name), ['run_code'])
    assert.equal(tallyOf(await call(old.harness, { part: 'tally', tally: 'skills' })).stats.length, 0)
  } finally {
    old.harness.dispose()
  }
}

describe('PTC accounting upgrade: derived cache generations', () => {
  test('an accounting generation change rebuilds the cold rows without a folded marker and keeps them across a restart', async () => {
    const target = storage()
    await seedOldGeneration(target)
    const persisted = openOverviewDatabase({ path: target.databasePath, generation: OLD_GENERATION })
    assert.ok(persisted !== null)
    assert.equal((persisted.get('SELECT COUNT(*) AS n FROM cache_session') as { n: number } | undefined)?.n, 2, 'the old generation persisted its derived rows')
    persisted.close()

    const upgraded = await bootWithCache(target, NEW_GENERATION, valuesMap('new'))
    try {
      assert.equal(upgraded.cache.database?.revision, null, 'the older revision stays gated until a sync commits')
      assert.equal(upgraded.harness.state.foldedVersion, 0, 'no backfill fold marker is involved')
      const summary = summaryOf(await call(upgraded.harness, { part: 'summary' }))
      assert.deepEqual(summary.timing?.tools, { read: { calls: 2, ms: 3_000 } }, 'the transport accounting is gone')
      assert.deepEqual(tallyOf(await call(upgraded.harness, { part: 'tally', tally: 'tools' })).stats.map(stat => stat.name), ['read'])
      assert.deepEqual(tallyOf(await call(upgraded.harness, { part: 'tally', tally: 'skills' })).stats.map(stat => stat.name), ['tdd'])
      assert.deepEqual(upgraded.harness.calls.cached.sort(), ['a', 'b'], 'the old derived rows are never reused')
      await upgraded.cache.flush()
      assert.notEqual(upgraded.cache.database?.revision, null, 'the sync commits the new revision')
      const written = upgraded.cache.database?.get('SELECT COUNT(*) AS n FROM cache_session') as { n: number } | undefined
      assert.equal(written?.n, 2, 'the rebuilt rows replace the previous generation')
    } finally {
      upgraded.harness.dispose()
    }

    const restarted = await bootWithCache(target, NEW_GENERATION, valuesMap('new'))
    try {
      const summary = summaryOf(await call(restarted.harness, { part: 'summary' }))
      assert.deepEqual(summary.timing?.tools, { read: { calls: 2, ms: 3_000 } }, 'the upgraded rows survive a restart')
      assert.deepEqual(restarted.harness.calls.cached, [], 'the same generation reuses the derived rows without a projection read')
    } finally {
      restarted.harness.dispose()
    }
  })

  test('the production cache wiring rejects the previous generation end to end', async () => {
    const target = storage()
    await seedOldGeneration(target)
    const upgraded = await bootWithRoutes(target, valuesMap('new'))
    try {
      const summary = summaryOf(await call(upgraded, { part: 'summary' }))
      assert.deepEqual(summary.timing?.tools, { read: { calls: 2, ms: 3_000 } }, 'the wired generation rebuilds the cold rows')
      assert.deepEqual(tallyOf(await call(upgraded, { part: 'tally', tally: 'tools' })).stats.map(stat => stat.name), ['read'])
      assert.deepEqual(upgraded.calls.cached.sort(), ['a', 'b'], 'the old derived rows are never reused')
    } finally {
      upgraded.dispose()
    }
  })
})
