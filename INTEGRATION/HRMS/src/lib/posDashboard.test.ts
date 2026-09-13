import { describe, expect, it } from 'vitest'
import {
  businessTodayISO,
  describeDashboardError,
  emptySummary,
  formatAverageSale,
  formatBusinessDate,
  moneyReconciles,
  paymentMethodLabel,
  paymentShares,
  peso,
  LOW_STOCK_ALERT_LEVEL,
  stockAlerts,
  type DashboardSummary,
} from '@/lib/posDashboard'

function summary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    business_date: '2026-08-25',
    sales_collected: 330,
    product_sales: 300,
    fees_collected: 30,
    transaction_count: 3,
    items_sold: 7,
    average_sale: 110,
    low_stock_count: 2,
    out_of_stock_count: 1,
    ...overrides,
  }
}

describe('the three money figures', () => {
  it('reconcile: collected is sales plus the fees the customer paid', () => {
    expect(moneyReconciles(summary())).toBe(true)
  })

  it('catches a drift between the RPC and the labels', () => {
    expect(moneyReconciles(summary({ fees_collected: 0 }))).toBe(false)
  })

  it('tolerates float representation, not real disagreement', () => {
    expect(moneyReconciles(summary({ sales_collected: 330.001 }))).toBe(true)
    expect(moneyReconciles(summary({ sales_collected: 331 }))).toBe(false)
  })

  it('holds for a day with nothing on it', () => {
    expect(moneyReconciles(emptySummary())).toBe(true)
  })
})

describe('formatAverageSale', () => {
  it('shows a dash on a day with no sales, never ₱0.00', () => {
    // The RPC divides by nullif(count, 0). "₱0.00 average" would read as
    // "sales averaged nothing", which is a different and untrue claim from
    // "there were no sales".
    expect(formatAverageSale(null)).toBe('—')
    expect(formatAverageSale(undefined)).toBe('—')
  })

  it('formats a real average as pesos', () => {
    expect(formatAverageSale(110)).toBe('₱110.00')
  })
})

describe('the summary shape', () => {
  it('carries no cost, COGS, margin or profit field', () => {
    // The RPCs do not declare them; this pins the client type to the same
    // contract so a future edit here cannot start reading one.
    const keys = Object.keys(summary())
    for (const forbidden of [
      'unit_cost',
      'average_unit_cost',
      'total_cogs',
      'line_cogs',
      'gross_profit',
      'net_profit',
      'margin',
      // The standalone's own column names, so a copy-paste from it fails here.
      'net_sales',
    ]) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it('names its money figures for what they are', () => {
    const keys = Object.keys(summary())
    expect(keys).toContain('sales_collected')
    expect(keys).toContain('product_sales')
    expect(keys).toContain('fees_collected')
  })

  it('gives an unloaded day a full shape rather than undefined cards', () => {
    const empty = emptySummary('2026-08-25')
    expect(empty.transaction_count).toBe(0)
    expect(empty.items_sold).toBe(0)
    expect(empty.average_sale).toBeNull()
    expect(empty.business_date).toBe('2026-08-25')
  })
})

describe('formatBusinessDate', () => {
  it('reads the date as calendar fields, not as UTC midnight', () => {
    // new Date('2026-08-25') is parsed as UTC and renders as the 24th for
    // anyone west of Greenwich -- the same class of bug as the browser-local
    // day window this phase removed.
    expect(formatBusinessDate('2026-08-25')).toContain('25')
    expect(formatBusinessDate('2026-08-25')).toContain('2026')
  })

  it('is empty rather than "Invalid Date" when the day has not loaded', () => {
    expect(formatBusinessDate(undefined)).toBe('')
    expect(formatBusinessDate('')).toBe('')
  })
})

describe('businessTodayISO', () => {
  it('is the business calendar date, not the device one', () => {
    // 2026-08-25T16:30:00Z is already the 26th in Manila (UTC+8).
    expect(businessTodayISO(new Date('2026-08-25T16:30:00Z'))).toBe('2026-08-26')
    expect(businessTodayISO(new Date('2026-08-25T15:30:00Z'))).toBe('2026-08-25')
  })

  it('produces the format both a date input and the RPC accept', () => {
    expect(businessTodayISO(new Date('2026-08-25T02:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('paymentMethodLabel', () => {
  it('uses the till"s own labels so the two screens agree', () => {
    expect(paymentMethodLabel('cash')).toBe('Cash')
    expect(paymentMethodLabel('gcash')).toBe('GCash')
  })

  it('falls back to the raw value rather than rendering nothing', () => {
    expect(paymentMethodLabel('crypto')).toBe('crypto')
  })
})

describe('peso', () => {
  it('always shows two decimals', () => {
    expect(peso(0)).toBe('₱0.00')
    expect(peso(1234.5)).toBe('₱1,234.50')
  })
})

describe('describeDashboardError', () => {
  it('explains a branch the account does not manage', () => {
    expect(describeDashboardError(new Error('permission denied'))).toBe(
      'You do not manage that branch.'
    )
  })

  it('explains an expired session', () => {
    expect(describeDashboardError(new Error('Sign in to continue'))).toContain('session has expired')
  })

  it('never returns an empty string', () => {
    expect(describeDashboardError(null)).toBe("Today's figures could not be loaded.")
  })
})

describe('how the day was paid', () => {
  const method = (payment_method: string, amount_collected: number, transaction_count = 1) => ({
    payment_method,
    transaction_count,
    amount_collected,
  })

  it('gives each method its share of the takings', () => {
    const shares = paymentShares([method('cash', 750), method('gcash', 250)])
    expect(shares.map((s) => Math.round(s.share))).toEqual([75, 25])
  })

  it('puts the biggest first, whatever order it arrived in', () => {
    const shares = paymentShares([method('gcash', 50), method('cash', 900), method('qrph', 300)])
    expect(shares.map((s) => s.payment_method)).toEqual(['cash', 'qrph', 'gcash'])
  })

  it('divides by nothing on a day that took nothing', () => {
    const shares = paymentShares([method('cash', 0), method('gcash', 0)])
    expect(shares.every((s) => s.share === 0)).toBe(true)
    expect(shares.every((s) => Number.isFinite(s.share))).toBe(true)
  })

  it('leaves the amounts and counts exactly as they arrived', () => {
    const [cash] = paymentShares([method('cash', 750, 12)])
    expect(cash.amount_collected).toBe(750)
    expect(cash.transaction_count).toBe(12)
  })

  it('has nothing to say about an empty list', () => {
    expect(paymentShares([])).toEqual([])
  })
})

describe('what needs attention', () => {
  /**
   * The bug these replace: the card read the dashboard summary's two counts,
   * and the low one was computed as
   *
   *     quantity_on_hand > 0 AND quantity_on_hand <= low_stock_threshold
   *
   * with `low_stock_threshold integer not null default 0`. For any product
   * nobody had configured, that is `q > 0 AND q <= 0` -- unsatisfiable. Cavite
   * could hold five of something and raise no alert, for ever.
   *
   * Rows now come from get_branch_inventory, the same per-branch stock the
   * Products and Inventory pages read, and the condition is a flat `<= 5`.
   */
  const item = (
    name: string,
    quantity: number | null,
    over: { product_status?: string | null; is_available?: boolean } = {}
  ) => ({
    product_id: `p-${name}`,
    product_name: name,
    quantity_on_hand: quantity,
    ...over,
  })

  it('includes 0, 1 and 5, and excludes 6', () => {
    const alerts = stockAlerts([
      item('Six', 6),
      item('Five', 5),
      item('One', 1),
      item('Zero', 0),
    ])
    expect(alerts.map((a) => a.name)).toEqual(['Zero', 'One', 'Five'])
    expect(alerts.map((a) => a.quantity)).toEqual([0, 1, 5])
  })

  it('reads the threshold as five inclusive, not as a truthiness check', () => {
    // The two ends that a `> 0` guard or a falsy test would silently drop.
    expect(stockAlerts([item('Zero', 0)]).map((a) => a.kind)).toEqual(['out'])
    expect(stockAlerts([item('Boundary', LOW_STOCK_ALERT_LEVEL)])).toHaveLength(1)
    expect(stockAlerts([item('Over', LOW_STOCK_ALERT_LEVEL + 1)])).toEqual([])
  })

  it('reproduces the reported Cavite shelf exactly', () => {
    const alerts = stockAlerts([
      item('Coca-Cola 5.6', 5),
      item('Sting 250ml', 0),
      item('ZZ PayMongo Verification', 19),
    ])
    expect(alerts.map((a) => [a.name, a.quantity, a.kind])).toEqual([
      ['Sting 250ml', 0, 'out'],
      ['Coca-Cola 5.6', 5, 'low'],
    ])
  })

  it('still flags a product the manager stopped on the till', () => {
    // The other half of the bug: the summary filtered on bp.is_available, so
    // pausing a line hid its empty shelf. Whether a till is offering something
    // says nothing about whether there is any of it.
    const alerts = stockAlerts([item('Stopped', 0, { is_available: false })])
    expect(alerts.map((a) => [a.name, a.kind])).toEqual([['Stopped', 'out']])
  })

  it('leaves out a product that is retired or not yet launched', () => {
    // The filter that looks like the one above and is not. Archiving is only a
    // status change -- the branch rows survive at whatever they held -- and the
    // till will never offer it again, so "0 remaining" is not a shortage anyone
    // can act on. Stopped is a pause; archived is an ending.
    const alerts = stockAlerts([
      item('Retired', 0, { product_status: 'archived' }),
      item('Unlaunched', 0, { product_status: 'draft' }),
      item('Live', 0, { product_status: 'active' }),
    ])
    expect(alerts.map((a) => a.name)).toEqual(['Live'])
  })

  it('keeps a row whose status it cannot read', () => {
    // The card's failure mode is hiding a real empty shelf. An unknown value
    // must never be the reason something disappears from it.
    expect(stockAlerts([item('No status given', 0)]).map((a) => a.name)).toEqual([
      'No status given',
    ])
    expect(stockAlerts([item('Null status', 0, { product_status: null })])).toHaveLength(1)
  })

  it('does not let a status filter hide a stopped product', () => {
    // Both filters at once, which is where a careless `&&` would go wrong: an
    // active product, paused on the till, with nothing on the shelf. This is
    // the exact row the original bug hid, and it must survive both tests.
    const alerts = stockAlerts([
      item('Paused but empty', 0, { is_available: false, product_status: 'active' }),
    ])
    expect(alerts.map((a) => [a.name, a.kind])).toEqual([['Paused but empty', 'out']])
  })

  it('puts the empty shelves first, then the lowest quantities', () => {
    const alerts = stockAlerts([item('Four', 4), item('Empty', 0), item('Two', 2)])
    expect(alerts.map((a) => a.quantity)).toEqual([0, 2, 4])
  })

  it('breaks ties by name so the order does not wander', () => {
    const alerts = stockAlerts([item('Beta', 0), item('Alpha', 0)])
    expect(alerts.map((a) => a.name)).toEqual(['Alpha', 'Beta'])
  })

  it('treats a missing quantity as nothing on the shelf', () => {
    expect(stockAlerts([item('Unknown', null)]).map((a) => a.kind)).toEqual(['out'])
  })

  it('says nothing at all when every shelf is stocked', () => {
    expect(stockAlerts([item('Plenty', 40), item('Loads', 6)])).toEqual([])
  })

  it('has nothing to say before the stock arrives', () => {
    // Distinct from "everything is in stock" -- the card decides that, and only
    // after a successful query.
    expect(stockAlerts(undefined)).toEqual([])
  })
})
