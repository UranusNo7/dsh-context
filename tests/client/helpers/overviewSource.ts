import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { vi } from 'vitest'
import type { BackfillCoverage, OverviewRequest, OverviewScope } from '../../../src/shared/types'
import { mount, type Mounted } from './kit'

export const OVERVIEW_ROUTE = 'api/dsh-context/overview'

export const BACKFILL_ROUTE = 'api/dsh-context/backfill'

export const POLL_MS = 30_000

export interface Modules {
  source: typeof import('../../../src/client/overviewSource')
  invalidation: typeof import('../../../src/client/invalidation')
  cache: typeof import('../../../src/client/overviewCache')
}

export async function fresh(): Promise<Modules> {
  vi.resetModules()
  const source = await import('../../../src/client/overviewSource')
  const invalidation = await import('../../../src/client/invalidation')
  const cache = await import('../../../src/client/overviewCache')
  return { source, invalidation, cache }
}

export interface Call {
  route: string
  body: Record<string, unknown>
  method: string | undefined
}

export type Handler = (call: Call, index: number) => unknown

export function stubRoutes(handler: Handler): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: unknown, init?: { body?: string; method?: string }) => {
    const call: Call = {
      route: String(input),
      body: init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>,
      method: init?.method,
    }
    calls.push(call)
    const value = await handler(call, calls.length - 1)
    return { ok: true, json: async () => ({ ok: true, value }) }
  })
  return calls
}

export function stubFailing(failure: 'thrown' | 'http' | 'envelope' | 'malformed'): void {
  if (failure === 'thrown') {
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    return
  }
  if (failure === 'http') {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }))
    return
  }
  if (failure === 'envelope') {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ ok: false }) }))
    return
  }
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    json: async () => ({ ok: true, value: { revision: 'r1', pricingReady: true, nope: 1 } }),
  }))
}

export function stubManual(): { calls: Call[]; releases: ((value: unknown) => void)[] } {
  const calls: Call[] = []
  const releases: ((value: unknown) => void)[] = []
  vi.stubGlobal('fetch', async (input: unknown, init?: { body?: string; method?: string }) => {
    calls.push({
      route: String(input),
      body: init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>,
      method: init?.method,
    })
    const value = await new Promise<unknown>((resolve) => { releases.push(resolve) })
    return { ok: true, json: async () => ({ ok: true, value }) }
  })
  return { calls, releases }
}

export const BASE_COVERAGE: BackfillCoverage = {
  complete: true,
  running: false,
  remaining: 0,
  failed: 0,
  total: 2,
  covered: 2,
  unsupported: 0,
}

export function coverageOf(over: Partial<BackfillCoverage> = {}): BackfillCoverage {
  return { ...BASE_COVERAGE, ...over }
}

export function summaryRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessions: 2,
    sessionsTotal: 3,
    sessionsArchived: 1,
    archivedScoped: 1,
    tokens: 1800,
    turns: 5,
    costUsd: 0.5,
    costSessions: 1,
    usageSessions: 1,
    cacheHit: '33.33',
    tokenParts: [{ key: 'system', value: 100 }, { key: 'tools', value: 20 }],
    timing: { wallMs: 1000, ttftMs: 0, genMs: 0, calls: 2, toolsMs: 0, toolCalls: 0, tools: {} },
    coverage: coverageOf(),
    ...over,
  }
}

export function summaryValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { revision: 'r1', pricingReady: true, summary: summaryRaw(), ...over }
}

export function daysValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { revision: 'r1', pricingReady: true, days: [{ key: '2026-09-16', tokens: 10, sessions: 1, costUsd: 0.1 }], ...over }
}

export function pageValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: 'r1',
    pricingReady: false,
    page: {
      items: [{
        id: 's1',
        title: 'one',
        cwd: '/repo',
        updatedAt: 5,
        running: true,
        archived: false,
        group: 'w',
        tokens: 10,
        turns: 2,
        steps: 3,
        parts: [{ key: 'system', value: 7 }],
        total: 7,
        contextWindow: 100,
        maxOutputTokens: 50,
        model: 'm',
        lastUser: 'hi',
        costUsd: 0.25,
        createdDay: '2026-09-10',
      }],
      index: 0,
      count: 1,
      total: 1,
      scopeTotal: 4,
      groups: [{ key: 'w', count: 1 }],
    },
    ...over,
  }
}

export function tallyValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: 'r1',
    pricingReady: true,
    tally: { field: 'tools', stats: [{ name: 'read', n: 2, sessions: 1, last: 5 }] },
    ...over,
  }
}

export interface SummaryProbe {
  states: import('../../../src/client/overviewSource').OverviewSummaryState[]
  m: Mounted
  update: (next: OverviewScope | null, nextEnabled?: boolean) => Promise<void>
}

export async function mountSummary(mod: Modules, scope: OverviewScope | null, enabled = true): Promise<SummaryProbe> {
  const states: SummaryProbe['states'] = []
  function Probe(props: { scope: OverviewScope | null; enabled: boolean }): null {
    states.push(mod.source.useOverviewSummary(props.scope, props.enabled))
    return null
  }
  const m = await mount(h(Probe, { scope, enabled }))
  return { states, m, update: (next, nextEnabled = enabled) => m.update(h(Probe, { scope: next, enabled: nextEnabled })) }
}

export interface DaysProbe {
  states: import('../../../src/client/overviewSource').PartState<{ days: import('../../../src/shared/types').OverviewDay[]; pricingReady: boolean }>[]
  m: Mounted
}

export async function mountDays(mod: Modules, scope: OverviewScope | null, enabled = true): Promise<DaysProbe> {
  const states: DaysProbe['states'] = []
  function Probe(props: { scope: OverviewScope | null; enabled: boolean }): null {
    states.push(mod.source.useOverviewDays(props.scope, props.enabled))
    return null
  }
  const m = await mount(h(Probe, { scope, enabled }))
  return { states, m }
}

export interface PageProbe {
  states: import('../../../src/client/overviewSource').PartState<{ page: import('../../../src/shared/types').OverviewPage; pricingReady: boolean }>[]
  m: Mounted
}

export async function mountPage(mod: Modules, request: Omit<OverviewRequest, 'revision'> | null, enabled = true): Promise<PageProbe> {
  const states: PageProbe['states'] = []
  function Probe(props: { request: Omit<OverviewRequest, 'revision'> | null; enabled: boolean }): null {
    states.push(mod.source.useOverviewPage(props.request, props.enabled))
    return null
  }
  const m = await mount(h(Probe, { request, enabled }))
  return { states, m }
}

export interface TallyProbe {
  states: import('../../../src/client/overviewSource').PartState<{ tally: import('../../../src/shared/types').OverviewTally; pricingReady: boolean }>[]
  m: Mounted
}

export async function mountTally(mod: Modules, request: Omit<OverviewRequest, 'revision'> | null, enabled = true): Promise<TallyProbe> {
  const states: TallyProbe['states'] = []
  function Probe(props: { request: Omit<OverviewRequest, 'revision'> | null; enabled: boolean }): null {
    states.push(mod.source.useOverviewTally(props.request, props.enabled))
    return null
  }
  const m = await mount(h(Probe, { request, enabled }))
  return { states, m }
}

export function lastOf<T>(states: T[]): T {
  const found = states[states.length - 1]
  assert.ok(found !== undefined, 'the probe rendered')
  return found
}

export async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
