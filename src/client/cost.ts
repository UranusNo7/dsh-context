import type { LocaleService } from './services'
import { currencyOf } from './currency'
import type { CostCurrency } from '../shared/pricing'

export * from '../shared/pricing'

export function formatCost(amount: number, currency: CostCurrency): string {
  const symbol = currency === 'cny' ? '¥' : '$'
  return symbol + (amount >= 1 ? amount.toFixed(2) : amount.toPrecision(2))
}

export function displayCurrencyOf(locale: LocaleService): CostCurrency {
  return currencyOf('auto', typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en')
}

export function formatPriceRate(amount: number, currency: CostCurrency): string {
  return (currency === 'cny' ? '¥' : '$') + amount.toFixed(2)
}
