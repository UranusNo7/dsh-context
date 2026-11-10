import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { calculateSessionCost, priceResolutionOf, pricesBookOf } from '../../src/shared/pricing'

const MODEL = 'deepseek/deepseek-v4.1-flash'
const CANONICAL = `${MODEL}-1017`
const OFFICIAL = { input: 0.15, output: 0.6, cache_read: 0.003 }

function bookOf() {
  const book = pricesBookOf({
    deepseek: { models: {
      'deepseek-v4-flash-vision-exp': { cost: OFFICIAL, canonical_model_id: CANONICAL },
      'deepseek-flash': { cost: OFFICIAL, canonical_model_id: CANONICAL },
      'deepseek-v4-flash': { cost: OFFICIAL, canonical_model_id: CANONICAL },
    } },
    carrier: { models: { [MODEL]: { cost: { input: 0.3, output: 1.2 }, canonical_model_id: MODEL } } },
    other: { models: { [MODEL]: { cost: { input: 0.2, output: 0.6 }, canonical_model_id: MODEL } } },
    commandgoat: { models: { [MODEL]: { cost: { input: 0, output: 0 }, canonical_model_id: MODEL } } },
  })
  assert.ok(book !== null)
  return book
}

describe('official reference prices for subscription routes', () => {
  test('uses the maker canonical alias instead of plan or disagreeing carrier prices', () => {
    const book = bookOf()
    for (const provider of ['commandgoat', 'example-token-plan', 'unknown']) {
      const resolved = priceResolutionOf(book, provider, MODEL)
      assert.equal(resolved.kind, 'priced')
      assert.ok(resolved.kind === 'priced')
      assert.equal(resolved.face.pid, 'deepseek')
      assert.equal(resolved.face.mid, 'deepseek-flash')
      assert.equal(resolved.face.canonical, CANONICAL)
      assert.deepEqual(resolved.face.rate, { miss: 0.15, hit: 0.003, write: 0.15, out: 0.6 })
    }
    assert.equal(calculateSessionCost({ commandgoat: { [MODEL]: { off: {
      uncached: 39_900_000, cacheRead: 70_500_000, cacheWrite: 0, output: 191_100,
    } } } }, book), 6.31116)
  })

  test('keeps direct carrier rates and resolves both bare and explicitly matching official versions', () => {
    const book = bookOf()
    const direct = priceResolutionOf(book, 'carrier', MODEL)
    assert.ok(direct.kind === 'priced')
    assert.equal(direct.face.pid, 'carrier')
    assert.equal(direct.face.rate.miss, 0.3)
    for (const model of ['deepseek-v4.1-flash', CANONICAL]) {
      const result = priceResolutionOf(book, 'commandgoat', model)
      assert.ok(result.kind === 'priced')
      assert.equal(result.face.pid, 'deepseek')
    }
    for (const suffix of ['-0910', '-fast', ':free', ':batch']) {
      assert.equal(priceResolutionOf(book, 'commandgoat', MODEL + suffix).kind, 'unpriced')
    }
  })

  test('subscriptions never label a carrier-only price as an official reference', () => {
    const book = pricesBookOf({ carrier: { models: {
      'private-model': { cost: OFFICIAL },
      'deepseek-future': { cost: OFFICIAL, canonical_model_id: 'deepseek/deepseek-future' },
    } } })
    assert.ok(book !== null)
    for (const model of ['private-model', 'carrier/private-model', 'carrier/deepseek-future']) {
      assert.equal(priceResolutionOf(book, 'commandgoat', model).kind, 'unpriced')
      assert.equal(priceResolutionOf(book, 'example-token-plan', model).kind, 'unpriced')
      assert.equal(priceResolutionOf(book, 'ordinary-proxy', model).kind, 'priced')
    }
  })

  test('does not guess between conflicting maker aliases or import another lab canonical identity', () => {
    const conflicting = pricesBookOf({ deepseek: { models: {
      first: { cost: OFFICIAL, canonical_model_id: CANONICAL },
      second: { cost: { input: 2, output: 3 }, canonical_model_id: CANONICAL },
      unrelated: { cost: OFFICIAL, canonical_model_id: 'anthropic/claude-special' },
    } } })
    assert.ok(conflicting !== null)
    const result = priceResolutionOf(conflicting, 'commandgoat', MODEL)
    assert.ok(result.kind === 'unpriced' && result.miss.reason === 'ambiguous')
    assert.equal(priceResolutionOf(conflicting, 'deepseek', 'claude-special').kind, 'unpriced')
  })
})
