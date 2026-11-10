import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { makeOverviewPanel } from '../../../src/client/components/overviewPanel'
import { resetOverviewRevision } from '../../../src/client/overviewSource'
import { resetInvalidations } from '../../../src/client/invalidation'
import { createContextSettings } from '../../../src/client/settings'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { flush, makeKit, mount, query, queryAll, settle, text } from '../helpers/kit'
import {
  panelPageValue as pageValueFor, panelSummaryValue as summaryValueFor,
  panelSessionsSnapshot, stubPanelRoutes as stubRoutes, useHookOf,
} from '../overview.fixtures'

function makeCtx(): TestClientCtx {
  return new TestClientCtx({ services: { sessions: {} } })
}

async function openPanel(ctx: TestClientCtx) {
  const Panel = makeOverviewPanel(asClientCtx(ctx), makeKit(), createContextSettings())
  const m = await mount(h(Panel, { useSessions: useHookOf(panelSessionsSnapshot()) }))
  await flush()
  await settle(5)
  return { m }
}

function cardsOf(container: HTMLElement): HTMLElement[] {
  return queryAll(container, '.lc-ov-grid > .lc-ov-session')
}

beforeEach(() => { resetOverviewRevision() })
afterEach(() => {
  resetOverviewRevision()
  resetInvalidations()
  vi.unstubAllGlobals()
})

describe('OverviewPanel loading states', () => {
  test('a pending first page shows loading in the list, not an empty session set', async () => {
    let releasePage: ((value: unknown) => void) | null = null
    stubRoutes({ page: () => new Promise<unknown>((resolve) => { releasePage = resolve }) })
    const { m } = await openPanel(makeCtx())
    assert.equal(text(query(m.container, '.lc-ov-status')), DICT_EN['ov.loading'], 'the header states the first load')
    assert.equal(text(query(m.container, '.lc-ov-list .lc-empty')), DICT_EN['ov.loading'], 'the list never claims there are no sessions')
    assert.equal(text(query(m.container, '.lc-ov-list-count')), '—')
    await act(async () => { releasePage?.(pageValueFor({ scope: { range: '30d', coverage: 'all' }, sort: 'recent', page: 0 })) })
    await flush()
    await settle(1)
    assert.equal(m.container.querySelector('.lc-ov-list .lc-empty'), null)
    assert.equal(cardsOf(m.container).length, 2)
    assert.equal(m.container.querySelector('.lc-ov-status'), null, 'the settled page clears the loading note')
    await m.unmount()
  })

  test('a failed first summary shows a visible failure instead of zeroed tiles', async () => {
    stubRoutes({ summary: () => Promise.reject(new Error('offline')) })
    const { m } = await openPanel(makeCtx())
    assert.equal(text(query(m.container, '.lc-ov-status')), DICT_EN['ov.loadFailed'])
    assert.deepEqual(queryAll(m.container, '.lc-stat-value').map(el => el.textContent), ['—', '—', '—', '—', '—', '—'])
    assert.equal(queryAll(m.container, '.lc-ov-stats .lc-deferred-skeleton').length, 2, 'the composition cards stay placeholders')
    await m.unmount()
  })

  test('a failed background refresh keeps the cached figures and marks them as not updated', async () => {
    stubRoutes()
    const first = await openPanel(makeCtx())
    assert.equal(queryAll(first.m.container, '.lc-stat-value').map(el => el.textContent)[1], '1.8k')
    await first.m.unmount()

    stubRoutes({ summary: () => Promise.reject(new Error('offline')) })
    const { m } = await openPanel(makeCtx())
    assert.equal(text(query(m.container, '.lc-ov-status')), DICT_EN['ov.notUpdated'])
    assert.deepEqual(queryAll(m.container, '.lc-stat-value').map(el => el.textContent), ['2', '1.8k', '$1.50', '33.33%', '14', '3m0s'], 'the last complete read stays on screen')
    assert.equal(cardsOf(m.container).length, 2)
    assert.ok(!query(m.container, '.lc-ov-page').className.includes('lc-ov-busy'))
    await m.unmount()
  })

  test('lazily loading tally cards say loading instead of no tools or commands', async () => {
    stubRoutes({ tally: () => new Promise<unknown>(() => {}) })
    const { m } = await openPanel(makeCtx())
    const cards = queryAll(m.container, '.lc-ov-tally-card')
    assert.equal(cards.length, 3)
    for (const card of cards) {
      assert.equal(text(query(card, '.lc-empty')), DICT_EN['ov.loading'])
      assert.equal(text(query(card, '.lc-ov-tally-note')), '—', 'the card never prints a zero summary before data lands')
    }
    assert.equal(text(query(m.container, '.lc-ov-status')), DICT_EN['ov.loading'])
    await m.unmount()
  })

  test('failed tally parts keep their cards and state the failure instead of an empty list', async () => {
    stubRoutes({ tally: () => Promise.reject(new Error('offline')) })
    const { m } = await openPanel(makeCtx())
    const cards = queryAll(m.container, '.lc-ov-tally-card')
    assert.equal(cards.length, 3)
    for (const card of cards) {
      assert.equal(text(query(card, '.lc-empty')), DICT_EN['ov.loadFailed'])
      assert.equal(text(query(card, '.lc-ov-tally-note')), '—')
    }
    assert.equal(text(query(m.container, '.lc-ov-status')), DICT_EN['ov.loadFailed'])
    await m.unmount()
  })

  test('a failed days read marks the range as failed while the rest of the page stays usable', async () => {
    stubRoutes({ days: () => Promise.reject(new Error('offline')) })
    const { m } = await openPanel(makeCtx())
    assert.equal(text(query(m.container, '.lc-ov-status')), DICT_EN['ov.loadFailed'])
    assert.equal(queryAll(m.container, '.lc-stat-value').map(el => el.textContent)[1], '1.8k', 'the summary still paints')
    assert.equal(text(query(m.container, '.lc-ov-usage .lc-empty')), DICT_EN['ov.loadFailed'])
    assert.equal(text(query(m.container, '.lc-ov-heat-card .lc-empty')), DICT_EN['ov.loadFailed'])
    assert.ok(!text(m.container).includes('No activity yet'))
    await m.unmount()
  })

  test('pending days show loading in the usage and heatmap cards rather than empty activity', async () => {
    stubRoutes({ days: () => new Promise<unknown>(() => {}) })
    const { m } = await openPanel(makeCtx())
    assert.equal(text(query(m.container, '.lc-ov-usage .lc-empty')), DICT_EN['ov.loading'])
    assert.equal(text(query(m.container, '.lc-ov-heat-card .lc-empty')), DICT_EN['ov.loading'])
    assert.ok(!text(m.container).includes('No activity yet'))
    await m.unmount()
  })

  test('a failed page read is reported in the list, never painted as loading or an empty set', async () => {
    stubRoutes({ page: () => Promise.reject(new Error('offline')) })
    const { m } = await openPanel(makeCtx())
    assert.equal(text(query(m.container, '.lc-ov-list .lc-empty')), DICT_EN['ov.loadFailed'])
    assert.equal(text(query(m.container, '.lc-ov-list-count')), '—')
    assert.equal(text(query(m.container, '.lc-ov-status')), DICT_EN['ov.loadFailed'])
    assert.equal(queryAll(m.container, '.lc-stat-value').map(el => el.textContent)[1], '1.8k', 'the summary still paints')
    await m.unmount()
  })

  test('a failed summary over an empty page reports the failure instead of claiming an empty corpus', async () => {
    stubRoutes({
      summary: () => Promise.reject(new Error('offline')),
      page: () => ({ revision: 'p0', pricingReady: true, page: { items: [], index: 0, count: 1, total: 0, scopeTotal: 0, groups: [] } }),
    })
    const { m } = await openPanel(makeCtx())
    assert.equal(text(query(m.container, '.lc-ov-status')), DICT_EN['ov.loadFailed'])
    assert.equal(text(query(m.container, '.lc-ov-list .lc-empty')), DICT_EN['ov.loadFailed'])
    await m.unmount()
  })

  test('an empty page landing before the summary keeps loading, never claims there are no sessions', async () => {
    let releaseSummary: ((value: unknown) => void) | null = null
    stubRoutes({
      summary: () => new Promise<unknown>((resolve) => { releaseSummary = resolve }),
      page: () => ({ revision: 'p0', pricingReady: true, page: { items: [], index: 0, count: 1, total: 0, scopeTotal: 0, groups: [] } }),
    })
    const { m } = await openPanel(makeCtx())
    assert.equal(text(query(m.container, '.lc-ov-list .lc-empty')), DICT_EN['ov.loading'])
    assert.equal(text(query(m.container, '.lc-ov-status')), DICT_EN['ov.loading'])
    await act(async () => { releaseSummary?.(summaryValueFor({ scope: { range: '30d', coverage: 'all' } })) })
    await flush()
    await settle(1)
    assert.equal(text(query(m.container, '.lc-ov-list .lc-empty')), DICT_EN['ov.list.noMatch'], 'the settled summary confirms that the corpus is not empty')
    await m.unmount()
  })

  test('when both the summary and the page fail the panel states the list is unavailable', async () => {
    stubRoutes({ summary: () => Promise.reject(new Error('offline')), page: () => Promise.reject(new Error('offline')) })
    const { m } = await openPanel(makeCtx())
    assert.equal(text(query(m.container, '.lc-empty')), DICT_EN['ov.unavailable'])
    assert.equal(text(query(m.container, '.lc-ov-status')), DICT_EN['ov.loadFailed'])
    await m.unmount()
  })

  test('a returned page with no matches says so instead of claiming an empty corpus', async () => {
    stubRoutes({
      page: () => ({ revision: 'p0', pricingReady: true, page: { items: [], index: 0, count: 1, total: 0, scopeTotal: 0, groups: [] } }),
    })
    const { m } = await openPanel(makeCtx())
    assert.equal(text(query(m.container, '.lc-ov-list .lc-empty')), DICT_EN['ov.list.noMatch'])
    await m.unmount()
  })

  test('a failing tally part is reported even when the other parts landed', async () => {
    const landed = (field: string): Record<string, unknown> => ({ revision: 't0', pricingReady: true, tally: { field, stats: [] } })
    stubRoutes({ tally: body => (body.tally === 'tools' ? Promise.reject(new Error('offline')) : landed(String(body.tally))) })
    const tools = await openPanel(makeCtx())
    assert.equal(text(query(tools.m.container, '.lc-ov-status')), DICT_EN['ov.loadFailed'])
    const toolsCards = queryAll(tools.m.container, '.lc-ov-tally-card')
    assert.equal(text(query(toolsCards[1], '.lc-ov-tally-note')), '—')
    assert.equal(text(query(toolsCards[0], '.lc-ov-tally-note')), '0 skills · 0 loads')
    assert.equal(text(query(toolsCards[2], '.lc-ov-tally-note')), '0 programs · 0 runs')
    await tools.m.unmount()
    resetOverviewRevision()

    stubRoutes({ tally: body => (body.tally === 'cmds' ? Promise.reject(new Error('offline')) : landed(String(body.tally))) })
    const cmds = await openPanel(makeCtx())
    assert.equal(text(query(cmds.m.container, '.lc-ov-status')), DICT_EN['ov.loadFailed'])
    const cmdsCards = queryAll(cmds.m.container, '.lc-ov-tally-card')
    assert.equal(text(query(cmdsCards[2], '.lc-ov-tally-note')), '—')
    assert.equal(text(query(cmdsCards[0], '.lc-ov-tally-note')), '0 skills · 0 loads')
    assert.equal(text(query(cmdsCards[1], '.lc-ov-tally-note')), '0 tools · 0 calls')
    await cmds.m.unmount()
  })

})
