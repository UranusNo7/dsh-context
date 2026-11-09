import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { overviewValueOf } from '../../src/client/overviewSource'
import { summaryRaw, summaryValue } from './helpers/overviewSource'

function modelRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    inputTokens: 10,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    outputTokens: 5,
    totalTokens: 18,
    costUsd: 0.01,
    ...over,
  }
}

describe('overview summary models', () => {
  test('a host without the field carries no models key', () => {
    const decoded = overviewValueOf(summaryValue())
    assert.ok(decoded !== null && 'summary' in decoded)
    assert.equal('models' in decoded.summary, false)
  })

  test('decodes every bucket and keeps an unpriced model', () => {
    const decoded = overviewValueOf(summaryValue({
      summary: summaryRaw({
        models: [
          modelRaw(),
          modelRaw({ provider: 'opencode-go', model: 'other', costUsd: null }),
          modelRaw({ provider: 'opencode-go', model: 'other', costUsd: undefined }),
        ],
      }),
    }))
    assert.ok(decoded !== null && 'summary' in decoded)
    assert.deepEqual(decoded.summary.models, [
      {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        inputTokens: 10,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        outputTokens: 5,
        totalTokens: 18,
        costUsd: 0.01,
      },
      {
        provider: 'opencode-go',
        model: 'other',
        inputTokens: 10,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        outputTokens: 5,
        totalTokens: 18,
        costUsd: null,
      },
      {
        provider: 'opencode-go',
        model: 'other',
        inputTokens: 10,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        outputTokens: 5,
        totalTokens: 18,
        costUsd: null,
      },
    ])
  })

  test('keeps a row with an empty provider as a legal unknown ledger', () => {
    const decoded = overviewValueOf(summaryValue({
      summary: summaryRaw({ models: [modelRaw({ provider: '', model: 'unknown-model' })] }),
    }))
    assert.ok(decoded !== null && 'summary' in decoded)
    assert.deepEqual(decoded.summary.models, [
      {
        provider: '',
        model: 'unknown-model',
        inputTokens: 10,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        outputTokens: 5,
        totalTokens: 18,
        costUsd: 0.01,
      },
    ])
  })

  test('drops malformed rows and rejects a non-list models field', () => {
    const decoded = overviewValueOf(summaryValue({
      summary: summaryRaw({
        models: [
          null,
          {},
          modelRaw({ model: '' }),
          modelRaw({ inputTokens: -1 }),
          modelRaw({ cacheReadTokens: 'x' }),
          modelRaw({ cacheWriteTokens: Number.NaN }),
          modelRaw({ outputTokens: null }),
          modelRaw({ totalTokens: -2 }),
          modelRaw({ costUsd: 'free' }),
          modelRaw({ provider: '', model: 'kept' }),
        ],
      }),
    }))
    assert.ok(decoded !== null && 'summary' in decoded)
    assert.deepEqual(decoded.summary.models?.map(row => [row.provider, row.model]), [['', 'kept']])
    for (const models of [null, 'x', {}, 7]) {
      assert.equal(overviewValueOf(summaryValue({ summary: summaryRaw({ models }) })), null, `${String(models)} rejects`)
    }
  })
})
