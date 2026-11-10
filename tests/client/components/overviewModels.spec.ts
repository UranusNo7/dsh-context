import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { beforeEach, describe, test, vi } from 'vitest'
import { makeOverviewModels } from '../../../src/client/components/overviewModels'
import { makeOverviewPanel } from '../../../src/client/components/overviewPanel'
import { resetOverviewRevision } from '../../../src/client/overviewSource'
import { resetInvalidations } from '../../../src/client/invalidation'
import { createContextSettings, type ContextSettings } from '../../../src/client/settings'
import type { OverviewModelUsage } from '../../../src/shared/types'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, flush, makeKit, mount, queryAll, settle, text } from '../helpers/kit'
import {
  panelRows, panelSessionsSnapshot, panelSummaryRaw, panelSummaryValue, stubPanelRoutes, useHookOf,
} from '../overview.fixtures'

const MODELS: OverviewModelUsage[] = [
  { provider: 'deepseek', model: 'deepseek-chat', inputTokens: 1200, cacheReadTokens: 5000, cacheWriteTokens: 300, outputTokens: 900, totalTokens: 7400, costUsd: 1.5 },
  { provider: 'openrouter', model: 'vendor/unknown-model', inputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, totalTokens: 400, costUsd: null },
]

const OverviewModels = makeOverviewModels(makeKit())

function rowsOf(container: HTMLElement): HTMLElement[] {
  return queryAll(container, '.lc-ov-models-table tbody tr')
}

function cellsOf(row: HTMLElement): (string | null)[] {
  return queryAll(row, 'td').map(cell => cell.textContent)
}

describe('OverviewModels', () => {
  test('renders one row per provider+model with formatted buckets and estimated cost', async () => {
    const m = await mount(h(OverviewModels, { models: MODELS, currency: 'usd' }))
    const rows = rowsOf(m.container)
    assert.equal(rows.length, 2)
    assert.deepEqual(cellsOf(rows[0]), ['deepseek-chatdeepseek', '1.2k', '5.0k', '300', '900', '7.4k', '$1.50'])
    assert.equal(rows[0].querySelectorAll('.lc-ov-models-num').length, 6)
    assert.ok(text(m.container).includes(DICT_EN['ov.models.title']))
    assert.ok(text(m.container).includes(DICT_EN['ov.models.sub']), 'the estimate + unpriced note is stated')
    assert.deepEqual(
      queryAll(m.container, 'thead th').map(cell => cell.textContent),
      [DICT_EN['ov.models.model'], DICT_EN['ov.models.input'], DICT_EN['ov.models.cacheRead'],
        DICT_EN['ov.models.cacheWrite'], DICT_EN['ov.models.output'], DICT_EN['ov.models.total'], DICT_EN['ov.models.cost']],
    )
    assert.equal(queryAll(m.container, 'thead th').filter(cell => cell.className.includes('lc-ov-models-num')).length, 6)
    await m.unmount()
  })

  test('subscription prices are labelled as official references without changing tokens or currency conversion', async () => {
    const models = MODELS.map(row => ({ ...row, provider: 'commandgoat' }))
    for (const currency of ['usd', 'cny'] as const) {
      const m = await mount(h(OverviewModels, { models, currency }))
      const rows = rowsOf(m.container)
      const reference = rows[0].querySelector('.lc-ov-models-cost .lc-ov-models-provider')
      assert.equal(reference?.textContent, DICT_EN['ov.models.reference'])
      assert.equal(cellsOf(rows[0])[6], (currency === 'usd' ? '$1.50' : '¥10.00') + DICT_EN['ov.models.reference'])
      assert.equal(cellsOf(rows[0])[5], '7.4k')
      assert.equal(rows[1].querySelector('.lc-ov-models-cost .lc-ov-models-provider'), null)
      assert.equal(cellsOf(rows[1])[6], '—')
      await m.unmount()
    }
  })

  test('pending prices are distinct from unpriced models without hiding existing money or tokens', async () => {
    const m = await mount(h(OverviewModels, { models: MODELS, currency: 'usd', pricingReady: false }))
    assert.ok(text(m.container).includes(DICT_EN['ov.pricingPending']))
    assert.ok(!text(m.container).includes(DICT_EN['ov.models.sub']))
    assert.equal(cellsOf(rowsOf(m.container)[0])[6], '$1.50')
    assert.equal(cellsOf(rowsOf(m.container)[1])[6], '—')
    assert.equal(cellsOf(rowsOf(m.container)[0])[5], '7.4k')
    await m.unmount()
  })

  test('an unpriced model shows — and the currency preference converts only priced rows', async () => {
    const usd = await mount(h(OverviewModels, { models: MODELS, currency: 'usd' }))
    assert.deepEqual(cellsOf(rowsOf(usd.container)[1]), ['vendor/unknown-modelopenrouter', '300', '0', '0', '100', '400', '—'])
    await usd.unmount()
    const cny = await mount(h(OverviewModels, { models: MODELS, currency: 'cny' }))
    assert.equal(cellsOf(rowsOf(cny.container)[0])[6], '¥10.00')
    assert.equal(cellsOf(rowsOf(cny.container)[1])[6], '—', 'an unpriced row never converts a placeholder')
    await cny.unmount()
  })
})

function reactiveSettings(): { settings: ContextSettings; sets: { field: string; value: unknown }[] } {
  let value: Record<string, unknown> = { defaultOverviewRange: '30d' }
  const listeners = new Set<() => void>()
  const sets: { field: string; value: unknown }[] = []
  const settings = createContextSettings()
  settings.attach({
    getSnapshot: () => ({ status: 'ready', value, writable: true }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: async (field, next) => {
      sets.push({ field, value: next })
      value = { ...value, [field]: next }
      for (const listener of listeners) listener()
    },
  })
  return { settings, sets }
}

function panelSummaryWithModels(body: Record<string, unknown>): Record<string, unknown> {
  const base = panelSummaryValue(body, panelRows())
  return { ...base, summary: panelSummaryRaw({ models: MODELS }) }
}

async function openPanel(settings: ContextSettings): Promise<{ m: Awaited<ReturnType<typeof mount>> }> {
  const ctx = new TestClientCtx({ services: { sessions: {} } })
  const Panel = makeOverviewPanel(asClientCtx(ctx), makeKit(), settings)
  const m = await mount(h(Panel, { useSessions: useHookOf(panelSessionsSnapshot()) } as never))
  await flush()
  await settle(5)
  return { m }
}

describe('overview panel model detail and currency switch', () => {
  beforeEach(() => {
    resetOverviewRevision()
    resetInvalidations()
    vi.unstubAllGlobals()
  })

  test('the model area stays hidden when the summary carries no models (old host)', async () => {
    stubPanelRoutes()
    const { settings, sets } = reactiveSettings()
    const { m } = await openPanel(settings)
    assert.equal(m.container.querySelector('.lc-ov-models'), null)
    const toggle = queryAll<HTMLButtonElement>(m.container, '.lc-ov-currency .lc-gran-btn')
    assert.equal(toggle.length, 2, 'the currency switch is always offered')
    assert.ok(toggle[1].title.includes(DICT_EN['stats.costTipCny']), 'the CNY option states its reference exchange rate')
    assert.ok(toggle[0].className.includes('lc-gran-on'), 'the English locale defaults to USD')
    await click(toggle[0])
    assert.deepEqual(sets, [{ field: 'displayCurrency', value: 'usd' }], 'auto + en still saves an explicit USD when the lit chip is picked')
    await click(toggle[0])
    assert.equal(sets.length, 1, 'picking an already explicit currency writes nothing')
    await m.unmount()
  })

  test('summary models render in the panel and the header switch moves every estimated figure to CNY', async () => {
    const calls = stubPanelRoutes({ summary: panelSummaryWithModels })
    const { settings, sets } = reactiveSettings()
    const { m } = await openPanel(settings)
    const rows = rowsOf(m.container)
    assert.equal(rows.length, 2)
    assert.equal(cellsOf(rows[0])[6], '$1.50')
    const usdKpi = queryAll<HTMLElement>(m.container, '.lc-ov-kpi')[2]
    assert.ok(text(usdKpi).includes('$1.50'))
    const overviewCalls = (): number => calls.filter(call => call.route.endsWith('/overview')).length
    const beforeSwitch = overviewCalls()
    const toggle = queryAll<HTMLButtonElement>(m.container, '.lc-ov-currency .lc-gran-btn')
    assert.ok(toggle[0].className.includes('lc-gran-on'))
    await click(toggle[1])
    assert.deepEqual(sets, [{ field: 'displayCurrency', value: 'cny' }], 'the pick persists through the settings port')
    assert.equal(overviewCalls(), beforeSwitch, 'a currency switch refetches nothing: the scope and revision are unchanged')
    const after = queryAll<HTMLButtonElement>(m.container, '.lc-ov-currency .lc-gran-btn')
    assert.ok(after[1].className.includes('lc-gran-on'))
    assert.ok(!after[0].className.includes('lc-gran-on'))
    assert.equal(cellsOf(rowsOf(m.container)[0])[6], '¥10.00')
    assert.ok(text(queryAll<HTMLElement>(m.container, '.lc-ov-kpi')[2]).includes('¥10.00'), 'the KPI follows the same currency')
    assert.equal(cellsOf(rowsOf(m.container)[1])[6], '—')
    await click(after[0])
    assert.deepEqual(sets, [{ field: 'displayCurrency', value: 'cny' }, { field: 'displayCurrency', value: 'usd' }])
    assert.equal(cellsOf(rowsOf(m.container)[0])[6], '$1.50')
    await click(after[0])
    assert.equal(sets.length, 2, 'picking the active currency writes nothing')
    await m.unmount()
  })

  test('the switch stays disabled until the settings form is ready and writable, then follows scope updates', async () => {
    stubPanelRoutes({ summary: panelSummaryWithModels })
    let snapshot: { status: string; value: unknown; writable: boolean } = { status: 'loading', value: {}, writable: false }
    const listeners = new Set<() => void>()
    const settings = createContextSettings()
    settings.attach({
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: () => Promise.resolve(),
    })
    const { m } = await openPanel(settings)
    const toggle = (): HTMLButtonElement[] => queryAll<HTMLButtonElement>(m.container, '.lc-ov-currency .lc-gran-btn')
    assert.ok(toggle().every(b => b.disabled), 'a loading form cannot persist a currency pick')

    snapshot = { status: 'ready', value: { displayCurrency: 'usd' }, writable: true }
    await act(async () => { for (const listener of listeners) listener() })
    assert.ok(toggle().every(b => !b.disabled), 'a ready, writable form unlocks the switch')

    snapshot = { status: 'ready', value: { displayCurrency: 'usd' }, writable: false }
    await act(async () => { for (const listener of listeners) listener() })
    assert.ok(toggle().every(b => b.disabled), 'a form that turns read-only disables the switch again')
    await m.unmount()
  })

  test('a read-only settings port keeps the served currency in charge', async () => {
    stubPanelRoutes({ summary: panelSummaryWithModels })
    const value: Record<string, unknown> = { defaultOverviewRange: '30d', displayCurrency: 'cny' }
    const settings = createContextSettings()
    settings.attach({
      getSnapshot: () => ({ status: 'ready', value, writable: false }),
      subscribe: () => () => {},
      set: () => Promise.reject(new Error('read-only')),
    })
    const { m } = await openPanel(settings)
    assert.equal(cellsOf(rowsOf(m.container)[0])[6], '¥10.00', 'auto is not used: the served CNY preference wins')
    const toggle = queryAll<HTMLButtonElement>(m.container, '.lc-ov-currency .lc-gran-btn')
    assert.ok(toggle[1].className.includes('lc-gran-on'))
    assert.ok(toggle.every(b => b.disabled), 'a read-only form cannot persist a currency pick')
    await m.unmount()
  })
})
