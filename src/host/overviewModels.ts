import type { CostBucketTotals, CostModelUsage, OverviewModelUsage, SessionCostUsage } from '../shared/types'
import type { CostSource } from './cost'
import { numOf } from './overviewCorpus'
import { asRecord } from './record'

const PERIODS = ['peak', 'off'] as const

function usageOf(provider: string, model: string, periods: CostModelUsage): SessionCostUsage {
  const usage = Object.create(null) as SessionCostUsage
  usage[provider] = { [model]: periods }
  return usage
}

function keyOf(model: OverviewModelUsage): string {
  return `${model.provider}\u0000${model.model}`
}

function compare(left: OverviewModelUsage, right: OverviewModelUsage): number {
  return (right.totalTokens - left.totalTokens) || (keyOf(left) < keyOf(right) ? -1 : 1)
}

export function modelsOf(usage: SessionCostUsage | null | undefined, cost: CostSource): OverviewModelUsage[] {
  if (usage === null || usage === undefined) return []
  const models: OverviewModelUsage[] = []
  for (const provider of Object.keys(usage)) {
    const branch = asRecord(usage[provider])
    if (branch === null) continue
    for (const model of Object.keys(branch)) {
      const periods = asRecord(branch[model])
      if (periods === null) continue
      const modelUsage: CostModelUsage = {}
      let inputTokens = 0
      let cacheReadTokens = 0
      let cacheWriteTokens = 0
      let outputTokens = 0
      let any = false
      for (const period of PERIODS) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        const totals: CostBucketTotals = {
          uncached: numOf(bucket.uncached),
          cacheRead: numOf(bucket.cacheRead),
          cacheWrite: numOf(bucket.cacheWrite),
          output: numOf(bucket.output),
        }
        modelUsage[period] = totals
        inputTokens += totals.uncached
        cacheReadTokens += totals.cacheRead
        cacheWriteTokens += totals.cacheWrite
        outputTokens += totals.output
        any = true
      }
      if (!any) continue
      models.push({
        provider,
        model,
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        outputTokens,
        totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
        costUsd: cost.usd(usageOf(provider, model, modelUsage)),
      })
    }
  }
  return models.sort(compare)
}
