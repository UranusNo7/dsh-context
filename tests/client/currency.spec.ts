import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { currencyOf } from '../../src/client/currency'

describe('currencyOf', () => {
  test('auto follows the locale default; an explicit choice wins over the locale', () => {
    assert.equal(currencyOf('auto', 'zh'), 'cny')
    assert.equal(currencyOf('auto', 'en'), 'usd')
    assert.equal(currencyOf('auto', 'ja'), 'usd')
    assert.equal(currencyOf('auto', ''), 'usd')
    assert.equal(currencyOf('usd', 'zh'), 'usd')
    assert.equal(currencyOf('cny', 'en'), 'cny')
  })
})
