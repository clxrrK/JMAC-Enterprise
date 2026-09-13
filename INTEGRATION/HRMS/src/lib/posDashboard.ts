import { saleMethodLabel } from '@/lib/posTill'
import { errorMessage } from '@/lib/errorMessage'

/**
 * The POS Manager's dashboard: the pure parts.
 *
 * Every figure here is operational. There is no cost, COGS, margin or profit
 * shaping to do, because none of the four dashboard RPCs declares such a
 * column -- the guarantee lives in the signatures, not in this file. What this
 * file does own is the labelling, and that matters more than it looks: the
 * standalone POS put `subtotal` on a card reading "Today's Net Sales" and never
 * showed what the customer actually paid, which understates the day at any
 * branch that charges a fee.
 *
 * So the three money figures are named for exactly what they are, and they
 * reconcile:
 *
 *     Sales Collected  =  Product Sales  +  Customer Fees
 */

export interface DashboardSummary {
  /** The business day the SERVER used, echoed back so the page can label the
   * day it is actually showing rather than the device's idea of today. */
  business_date: string
  /** What the till took, fees included. */
  sales_collected: number
  /** What the goods came to, before fees. */
  product_sales: number
  /** Fees the customer paid on top. */
  fees_collected: number
  transaction_count: number
  /** Units sold, not lines: three of one product on one line counts as three. */
  items_sold: number
  average_sale: number | null
  /** Point-in-time, not day-scoped -- "what is running out right now". */
  low_stock_count: number
  out_of_stock_count: number
}

export interface PaymentTotal {
  /** A method a SALE holds, not one the till offers -- so 'card', 'qrph' and
   *  'paymaya' appear here as well. Render it with paymentMethodLabel. */
  payment_method: string
  transaction_count: number
  amount_collected: number
}

export interface TopProduct {
  /** Grouped by the enterprise product, so a mid-period rename cannot split
   * one product into two ranked rows. */
  product_id: string
  /** The most recent sale-item snapshot name. */
  product_name: string
  quantity_sold: number
  sales_amount: number
}

export const RECENT_TRANSACTION_COUNT = 5
export const TOP_PRODUCT_COUNT = 5

export const peso = (value: number) =>
  `₱${Number(value ?? 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

export function paymentMethodLabel(method: string): string {
  return saleMethodLabel(method)
}

/** An empty day still has a shape. Without this the cards would flash `NaN`
 * and `undefined` at a branch that has not sold anything yet today. */
export function emptySummary(businessDate = ''): DashboardSummary {
  return {
    business_date: businessDate,
    sales_collected: 0,
    product_sales: 0,
    fees_collected: 0,
    transaction_count: 0,
    items_sold: 0,
    average_sale: null,
    low_stock_count: 0,
    out_of_stock_count: 0,
  }
}

/** `average_sale` is null on a day with no transactions -- the RPC divides by
 * `nullif(count, 0)` rather than returning a misleading zero. Render the
 * absence as a dash, never as `₱0.00`, which would read as "sales averaged
 * nothing" instead of "there were none". */
export function formatAverageSale(average: number | null | undefined): string {
  if (average === null || average === undefined || !Number.isFinite(Number(average))) return '—'
  return peso(Number(average))
}

/** The three money figures must add up, and the page says so out loud. If this
 * ever returns false the RPC and the labels have drifted apart. */
export function moneyReconciles(summary: DashboardSummary): boolean {
  const collected = Number(summary.sales_collected)
  const parts = Number(summary.product_sales) + Number(summary.fees_collected)
  // Two decimal places of currency; allow for float representation only.
  return Math.abs(collected - parts) < 0.005
}

/**
 * Each payment method's share of the day's takings.
 *
 * A manager reads this list to answer a practical question -- is there enough
 * cash in the drawer, is the card terminal carrying the day -- and a column of
 * amounts makes that a mental arithmetic problem. The proportion is the
 * answer, so the proportion is what gets drawn.
 *
 * Computed from the same amounts the rows already carry; nothing new is
 * fetched and no total is invented. A day that has taken nothing gives every
 * method a share of zero rather than dividing by it.
 */
export function paymentShares(
  rows: PaymentTotal[]
): (PaymentTotal & { share: number })[] {
  const total = rows.reduce((sum, r) => sum + Number(r.amount_collected ?? 0), 0)
  return rows
    .map((row) => ({
      ...row,
      share: total > 0 ? (Number(row.amount_collected ?? 0) / total) * 100 : 0,
    }))
    .sort((a, b) => b.amount_collected - a.amount_collected)
}

/**
 * The level at or below which a branch product is worth flagging.
 *
 * A fixed five, and deliberately not `pos_branch_inventory.low_stock_threshold`.
 * That column is `not null default 0`, so for every product nobody has
 * explicitly configured, "low" meant `quantity <= 0` -- which the dashboard
 * then intersected with `quantity > 0`. An empty set by construction: a branch
 * that had never set a threshold could not raise a low-stock alert at all, no
 * matter how little stock it held.
 */
export const LOW_STOCK_ALERT_LEVEL = 5

export interface StockAlert {
  product_id: string
  name: string
  quantity: number
  kind: 'out' | 'low'
}

/**
 * What is running out, as products to go and deal with.
 *
 * Rows come from `get_branch_inventory` -- the same authoritative per-branch
 * stock the Products and Inventory pages read, manager-gated in the database
 * and scoped to one branch by argument. Not the dashboard summary's counts,
 * which were the bug: they filtered on `bp.is_available`, so a product a
 * manager had stopped on the till vanished from the alerts at the exact moment
 * its stock hit zero.
 *
 * The quantity condition is `<= 5` and nothing else. No `> 0` guard, because
 * zero is the most urgent case and a truthiness check would drop it. Sold-today,
 * ever-sold and business-date are all irrelevant here and none is consulted.
 *
 * Two filters that look alike and are not:
 *
 *   `pos_branch_products.is_available` -- STOPPED ON THE TILL. Not applied.
 *   Whether a till is currently offering something says nothing about whether
 *   there is any of it, and a manager who pauses a line still needs to know the
 *   shelf is empty before they restart it.
 *
 *   `pos_products.status` -- RETIRED OR NOT YET LAUNCHED ENTERPRISE-WIDE. Applied.
 *   Archiving a product is only a status change: its branch rows survive at
 *   whatever quantity they held, and `get_pos_catalogue` will never offer it
 *   again. Listing those is not a shortage anybody can act on -- no delivery
 *   will arrive and no sale is being lost -- so they would be permanent noise
 *   in a card whose whole job is "go and deal with this".
 *
 * A row whose status is absent is kept. This card's failure mode is hiding a
 * real empty shelf, so an unknown value must never be the reason something
 * disappears.
 *
 * Out of stock first, then the lowest quantities: the empty shelves are
 * costing sales now, the rest are warnings about later. Name breaks ties so
 * the order is stable rather than whatever the server happened to return.
 */
export function stockAlerts(
  rows:
    | {
        product_id: string
        product_name: string
        quantity_on_hand: number | null
        product_status?: string | null
      }[]
    | undefined
): StockAlert[] {
  if (!rows) return []

  return rows
    .filter((row) => row.product_status == null || row.product_status === 'active')
    .map((row) => ({
      product_id: row.product_id,
      name: row.product_name,
      quantity: Number(row.quantity_on_hand ?? 0),
    }))
    .filter((row) => Number.isFinite(row.quantity) && row.quantity <= LOW_STOCK_ALERT_LEVEL)
    .map((row) => ({ ...row, kind: row.quantity === 0 ? ('out' as const) : ('low' as const) }))
    .sort((a, b) => a.quantity - b.quantity || a.name.localeCompare(b.name))
}

/** A business date as the page should title it. The string arrives from the
 * database as a plain `YYYY-MM-DD` calendar date with no timezone attached, so
 * it is parsed as local calendar fields -- `new Date('2026-08-25')` would be
 * read as UTC midnight and render as the 24th for anyone west of Greenwich. */
export function formatBusinessDate(iso: string | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-PH', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/** Today, on the business's calendar rather than the device's.
 *
 * Used only to seed a date input. Nothing computes a dashboard window from it:
 * the client sends either nothing or a plain calendar date, and
 * `pos_day_bounds()` decides what that means. */
export function businessTodayISO(now = new Date()): string {
  // en-CA renders as YYYY-MM-DD, which is the format a <input type="date">
  // and the RPC both want.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(now)
}

export function describeDashboardError(error: unknown): string {
  const message = errorMessage(error)
  if (message.includes('Sign in')) return 'Your session has expired. Sign in again.'
  if (message.includes('row-level security') || message.includes('permission denied')) {
    return 'You do not manage that branch.'
  }
  return message || "Today's figures could not be loaded."
}
