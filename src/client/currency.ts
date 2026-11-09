import { useCallback, useSyncExternalStore } from 'react'
import type { CostCurrency } from '../shared/pricing'
import type { DisplayCurrency } from '../shared/types'
import type { LocaleService } from './services'
import type { ContextSettings } from './settings'
import type { ViewKit } from './viewkit'

export function currencyOf(preference: DisplayCurrency, locale: string): CostCurrency {
  return preference === 'auto' ? (locale === 'zh' ? 'cny' : 'usd') : preference
}

export function activeLocaleOf(locale: LocaleService | undefined): string {
  return locale !== undefined && typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
}

export interface DisplayCurrencyState {
  currency: CostCurrency
  editable: boolean
}

export function useDisplayCurrencyState(settings: ContextSettings, locale: string, kit: ViewKit): DisplayCurrencyState {
  const subscribe = useCallback((listener: () => void) => settings.store.subscribe(listener), [settings])
  const getSnapshot = useCallback(() => settings.store.getSnapshot(), [settings])
  const state = useSyncExternalStore(subscribe, getSnapshot)
  kit.useLocaleTick()
  return {
    currency: currencyOf(state.displayCurrency, locale),
    editable: state.status === 'ready' && state.writable,
  }
}

export function useDisplayCurrency(settings: ContextSettings, locale: string, kit: ViewKit): CostCurrency {
  return useDisplayCurrencyState(settings, locale, kit).currency
}
