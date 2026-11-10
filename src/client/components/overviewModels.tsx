import type { ReactElement } from 'react'
import { formatCost, toCurrency, type CostCurrency } from '../cost'
import type { OverviewModelUsage } from '../../shared/types'
import { isSubscriptionPlanProvider } from '../../shared/priceIdentity'
import type { ViewKit } from '../viewkit'
import { IconDatabase } from '../primitives'

export interface OverviewModelsProps {
  models: readonly OverviewModelUsage[]
  currency: CostCurrency
  pricingReady?: boolean
}

export function makeOverviewModels(kit: ViewKit): (props: OverviewModelsProps) => ReactElement {
  const { t, fmt } = kit
  return function OverviewModels(props: OverviewModelsProps): ReactElement {
    const money = (usd: number | null): string => usd === null ? '—' : formatCost(toCurrency(usd, props.currency), props.currency)
    return (
      <div className="lc-card lc-ov-models">
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <IconDatabase size={14} />
            {t('ov.models.title')}
          </span>
          <span className="lc-card-sub">{t(props.pricingReady === false ? 'ov.pricingPending' : 'ov.models.sub')}</span>
        </div>
        <table className="lc-ov-models-table">
          <thead>
            <tr>
              <th scope="col">{t('ov.models.model')}</th>
              <th scope="col" className="lc-ov-models-num">{t('ov.models.input')}</th>
              <th scope="col" className="lc-ov-models-num">{t('ov.models.cacheRead')}</th>
              <th scope="col" className="lc-ov-models-num">{t('ov.models.cacheWrite')}</th>
              <th scope="col" className="lc-ov-models-num">{t('ov.models.output')}</th>
              <th scope="col" className="lc-ov-models-num">{t('ov.models.total')}</th>
              <th scope="col" className="lc-ov-models-num">{t('ov.models.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {props.models.map(row => (
              <tr key={row.provider + '\u0000' + row.model}>
                <td data-label={t('ov.models.model')}>
                  <span className="lc-ov-models-name">{row.model}</span>
                  <span className="lc-ov-models-provider">{row.provider}</span>
                </td>
                <td data-label={t('ov.models.input')} className="lc-ov-models-num">{fmt(row.inputTokens)}</td>
                <td data-label={t('ov.models.cacheRead')} className="lc-ov-models-num">{fmt(row.cacheReadTokens)}</td>
                <td data-label={t('ov.models.cacheWrite')} className="lc-ov-models-num">{fmt(row.cacheWriteTokens)}</td>
                <td data-label={t('ov.models.output')} className="lc-ov-models-num">{fmt(row.outputTokens)}</td>
                <td data-label={t('ov.models.total')} className="lc-ov-models-num">{fmt(row.totalTokens)}</td>
                <td data-label={t('ov.models.cost')} className="lc-ov-models-num lc-ov-models-cost">
                  {money(row.costUsd)}
                  {row.costUsd !== null && isSubscriptionPlanProvider(row.provider) && (
                    <span className="lc-ov-models-provider">{t('ov.models.reference')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
}
