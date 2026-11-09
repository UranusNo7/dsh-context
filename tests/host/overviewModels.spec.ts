import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { modelsOf } from '../../src/host/overviewModels'
import type { CostModelUsage, SessionCostUsage } from '../../src/shared/types'
import { costOfUsage, fakeCost } from './helpers/overview'

function usageEntry(usage: SessionCostUsage, provider: string, model: string): SessionCostUsage {
  return { [provider]: { [model]: usage[provider][model] } }
}

describe('dsh-context overview model usage', () => {

  test('modelsOf sums every bucket per provider and model, keeps same-named models apart, and orders by total tokens', () => {
    const flash = {
      off: { uncached: 10, cacheRead: 20, cacheWrite: 3, output: 5 },
      peak: { uncached: 1, cacheRead: 2, cacheWrite: 1, output: 1 },
    }
    const pro = { off: { uncached: 100, cacheRead: 0, cacheWrite: 0, output: 0 } }
    const shared = { off: { uncached: 50, cacheRead: 0, cacheWrite: 0, output: 0 } }
    const usage: SessionCostUsage = {
      deepseek: { 'deepseek-v4-flash': flash, 'deepseek-v4-pro': pro },
      openai: { 'deepseek-v4-flash': shared },
    }
    const models = modelsOf(usage, fakeCost(true))
    assert.deepEqual(models.map(entry => [entry.provider, entry.model, entry.inputTokens, entry.cacheReadTokens, entry.cacheWriteTokens, entry.outputTokens, entry.totalTokens]), [
      ['deepseek', 'deepseek-v4-pro', 100, 0, 0, 0, 100],
      ['openai', 'deepseek-v4-flash', 50, 0, 0, 0, 50],
      ['deepseek', 'deepseek-v4-flash', 11, 22, 4, 6, 43],
    ])
    for (const entry of models) {
      assert.equal(entry.costUsd, costOfUsage(usageEntry(usage, entry.provider, entry.model)))
    }
  })

  test('modelsOf leaves unpriced models in place with no cost while the priced models carry the money', () => {
    const priced = { off: { uncached: 20, cacheRead: 5, cacheWrite: 1, output: 2 } }
    const mystery: CostModelUsage = { off: { uncached: 30, cacheRead: 0, cacheWrite: 0, output: 3 } }
    const usage: SessionCostUsage = { deepseek: { 'deepseek-v4-flash': priced, mystery } }
    const models = modelsOf(usage, fakeCost(true, (_provider, model) => model === 'mystery'))
    assert.deepEqual(models.map(entry => [entry.model, entry.totalTokens, entry.costUsd]), [
      ['mystery', 33, null],
      ['deepseek-v4-flash', 28, costOfUsage({ deepseek: { 'deepseek-v4-flash': priced } })],
    ])
    assert.equal(models.filter(entry => entry.costUsd !== null).reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0), costOfUsage(usage, (_provider, model) => model === 'mystery'))
  })

  test('modelsOf reports no total cost when every model is unpriced or pricing is cold', () => {
    const usage = { deepseek: { mystery: { off: { uncached: 30 } } } } as unknown as SessionCostUsage
    assert.deepEqual(modelsOf(usage, fakeCost(true, () => true)).map(entry => [entry.model, entry.totalTokens, entry.costUsd]), [['mystery', 30, null]])
    assert.deepEqual(modelsOf(usage, fakeCost(false)).map(entry => entry.costUsd), [null])
  })

  test('modelsOf breaks total-token ties by provider and then by model', () => {
    const bucket = { off: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } }
    const usage: SessionCostUsage = {
      zeta: { alpha: bucket, beta: bucket },
      alpha: { gamma: bucket },
      mid: { alpha: bucket },
    }
    assert.deepEqual(modelsOf(usage, fakeCost(true)).map(entry => [entry.provider, entry.model]), [
      ['alpha', 'gamma'],
      ['mid', 'alpha'],
      ['zeta', 'alpha'],
      ['zeta', 'beta'],
    ])
  })

  test('modelsOf skips absent and empty periods, tolerates hostile buckets, and keeps odd names addressable', () => {
    const usage = JSON.parse('{"deepseek":{"empty":{},"junk":{"off":"no"},"__proto__":{"off":{"uncached":4,"cacheRead":-1,"output":2}}},"flat":"junk","other":{"leaf":"junk"}}') as SessionCostUsage
    assert.deepEqual(modelsOf(null, fakeCost(true)), [])
    assert.deepEqual(modelsOf({}, fakeCost(true)), [])
    assert.deepEqual(modelsOf(usage, fakeCost(true)).map(entry => [entry.model, entry.inputTokens, entry.cacheReadTokens, entry.totalTokens]), [
      ['__proto__', 4, -1, 5],
    ])
  })
})
