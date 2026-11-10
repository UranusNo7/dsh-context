import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { makeOverviewPanel } from '../../../src/client/components/overviewPanel'
import { resetOverviewRevision } from '../../../src/client/overviewSource'
import { invalidate, resetInvalidations } from '../../../src/client/invalidation'
import { createContextSettings } from '../../../src/client/settings'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { flush, makeKit, mount, query, queryAll, settle, text, until } from '../helpers/kit'
import { panelSummaryRaw, panelSessionsSnapshot, stubPanelRoutes, TODAY, useHookOf } from '../overview.fixtures'

afterEach(() => {
  resetOverviewRevision()
  resetInvalidations()
  vi.unstubAllGlobals()
})

test('pending prices update without remounting and keep genuinely unpriced models distinct', async () => {
  let ready = false
  const models = [
    { provider: 'commandgoat', model: 'deepseek/deepseek-v4.1-flash', inputTokens: 1000, cacheReadTokens: 700, cacheWriteTokens: 0, outputTokens: 100, totalTokens: 1800, costUsd: null as number | null },
    { provider: 'private', model: 'unknown', inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 1, costUsd: null },
  ]
  stubPanelRoutes({
    summary: () => ({ revision: ready ? 'priced' : 'cold', pricingReady: ready,
      summary: panelSummaryRaw({ costUsd: ready ? 1.5 : null, costSessions: ready ? 1 : 0,
        models: models.map((row, index) => ({ ...row, costUsd: ready && index === 0 ? 1.5 : null })) }) }),
    days: () => ({ revision: ready ? 'priced' : 'cold', pricingReady: ready,
      days: [{ key: TODAY, tokens: 1800, sessions: 2, costUsd: ready ? 1.5 : null }] }),
  })
  const ctx = new TestClientCtx({ services: { sessions: {} } })
  const Panel = makeOverviewPanel(asClientCtx(ctx), makeKit(), createContextSettings())
  const m = await mount(h(Panel, { useSessions: useHookOf(panelSessionsSnapshot()) }))
  try {
    await flush()
    await settle(5)
    const costTile = queryAll(m.container, '.lc-ov-kpi')[2]
    assert.ok(text(costTile).includes(DICT_EN['ov.pricingPending']))
    assert.ok(!text(costTile).includes('0 of 2 sessions priced'))
    assert.equal(text(query(costTile, '.lc-stat-value')), '—')
    assert.ok(text(query(m.container, '.lc-ov-models')).includes(DICT_EN['ov.pricingPending']))
    assert.ok(text(query(m.container, '.lc-ov-usage')).includes(DICT_EN['ov.pricingPending']))
    assert.equal(queryAll(m.container, '.lc-ov-models-table tbody tr').length, 2)
    assert.equal(queryAll(m.container, '.lc-stat-value')[1].textContent, '1.8k')
    await act(async () => { ready = true; invalidate('pricing') })
    await until(() => !text(m.container).includes(DICT_EN['ov.pricingPending']), 'the coalesced pricing refresh lands')
    assert.ok(!text(m.container).includes(DICT_EN['ov.pricingPending']))
    assert.equal(text(query(costTile, '.lc-stat-value')), '$1.50')
    assert.equal(text(query(costTile, '.lc-stat-sub')), '1 of 2 sessions priced')
    const rows = queryAll(m.container, '.lc-ov-models-table tbody tr')
    assert.ok(text(rows[0]).includes(DICT_EN['ov.models.reference']))
    assert.equal(queryAll(rows[1], 'td')[6].textContent, '—')
    assert.equal(queryAll(m.container, '.lc-ov-usage-col').length, 7)
  } finally {
    await m.unmount()
  }
})
