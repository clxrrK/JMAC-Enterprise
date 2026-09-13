import * as React from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Receipt, TrendingUp, Trophy, Wallet } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ManagerBranchPicker, useManagerBranch } from '@/components/pos/ManagerBranchPicker'
import { useBranchInventory } from '@/hooks/usePosInventory'
import type { InventoryRow } from '@/lib/posInventory'
import {
  useBusinessDay,
  useDashboardPaymentTotals,
  useDashboardRecentSales,
  useDashboardSummary,
  useDashboardTopProducts,
} from '@/hooks/usePosDashboard'
import {
  describeDashboardError,
  formatAverageSale,
  formatBusinessDate,
  moneyReconciles,
  paymentMethodLabel,
  paymentShares,
  peso,
  stockAlerts,
  type DashboardSummary,
} from '@/lib/posDashboard'

/**
 * The POS Manager's operational dashboard.
 *
 * Operational, and only operational. There is no cost, COGS, margin or profit
 * here -- not hidden behind a permission flag, but absent from the four RPC
 * signatures this page reads, so there is nothing on the wire to leak. The
 * standalone POS put "Today's Net Profit" on the manager's very first screen
 * and gated the whole query on `canViewProfit`; that is deliberately not
 * carried over.
 *
 * Two smaller inheritances are also corrected here. The standalone labelled
 * `subtotal` as "Net Sales" and never showed what the customer actually paid,
 * so a branch charging a fee under-reported its takings; this page shows Sales
 * Collected, Product Sales and Customer Fees, which reconcile. And it computed
 * "today" with `startOfDay(new Date())`, so the figures moved with the device
 * clock; the day here is resolved by `pos_day_bounds()` in Asia/Manila.
 */

/**
 * One of the day's figures.
 *
 * Sentence case, not the tracked-out uppercase this page used to set every
 * label in: six shouted labels give a manager no idea which figure matters,
 * and the one that does is decided below by size and tone instead.
 */
function Figure({
  label,
  value,
  hint,
  icon: Icon,
  loading,
}: {
  label: string
  value: string
  hint?: string
  icon: React.ComponentType<{ className?: string }>
  loading: boolean
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Icon className="h-4 w-4" aria-hidden="true" />
          {label}
        </div>
        {loading ? (
          <Skeleton className="mt-1 h-7 w-24" />
        ) : (
          <div className="font-display text-xl font-bold tabular-nums text-foreground">{value}</div>
        )}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}

/**
 * The day's takings, and what they are made of.
 *
 * The one figure a manager comes to this page for, so it is the only one set
 * large and the only one in teal -- the same teal the till uses for change due
 * and the register for total taken, so money reads the same colour everywhere.
 *
 * Its two components sit inside the same card rather than beside it as equals.
 * Sales Collected = Product Sales + Customer Fees was previously three cards of
 * identical weight and a paragraph underneath explaining the relationship; the
 * arithmetic is structural now, and the paragraph is gone.
 */
function TakingsCard({
  summary,
  loading,
}: {
  summary: DashboardSummary | undefined
  loading: boolean
}) {
  const reconciles = summary ? moneyReconciles(summary) : true

  return (
    <Card className="lg:col-span-2">
      {/* h-full, or the mt-auto below has no spare height to push into: the
          Card stretches to the grid row, the content box does not follow it
          on its own. */}
      <CardContent className="flex h-full flex-col gap-4 p-5">
        <div>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Wallet className="h-4 w-4" aria-hidden="true" />
            Sales collected today
          </p>
          {loading ? (
            <Skeleton className="mt-2 h-10 w-48" />
          ) : (
            <p className="mt-1 font-display text-4xl font-bold leading-none tabular-nums text-teal-ink">
              {peso(summary?.sales_collected ?? 0)}
            </p>
          )}
        </div>

        {/* mt-auto, because the row is as tall as the two stacked cards beside
            it and the difference has to go somewhere. Pooled under the last
            line it reads as an unfinished card; pushed between the headline and
            its components it reads as spacing. */}
        <div className="mt-auto grid grid-cols-2 gap-3 border-t border-border pt-3">
          <div>
            <p className="text-xs text-muted-foreground">Product sales</p>
            <p className="font-display text-lg font-semibold tabular-nums text-foreground">
              {loading ? '—' : peso(summary?.product_sales ?? 0)}
            </p>
            <p className="text-xs text-muted-foreground">What the goods came to</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Customer fees</p>
            <p className="font-display text-lg font-semibold tabular-nums text-foreground">
              {loading ? '—' : peso(summary?.fees_collected ?? 0)}
            </p>
            <p className="text-xs text-muted-foreground">Paid by the customer on top</p>
          </div>
        </div>

        {/* The lib has always been able to check that the three add up, and
            said the page should say so. It never did. Silence is right while
            they reconcile; if they ever stop, that is not a rounding curiosity
            -- it means the RPC and these labels have drifted apart. */}
        {!loading && !reconciles && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive"
          >
            These figures do not add up: product sales plus customer fees should equal what was
            collected. Raise it before relying on today's numbers.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * What is running out, as work rather than as a number.
 *
 * A manager reading "3 out of stock" cannot act on it: they have to go to
 * Inventory and find out which three. So the card names the products, gives
 * each its actual remaining quantity, and links to that branch's stock page.
 *
 * Every qualifying product is listed -- there is no top-N, because a cap here
 * would be a silent omission of exactly the thing the card exists to report.
 * A branch with a long list scrolls inside the card instead, and the header
 * says how many there are so the length is never a surprise.
 */
function StockPanel({
  rows,
  failed,
  branchId,
}: {
  /** The branch's stock, or `undefined` for every state that is not an answer:
   * still loading, and also DISABLED, which is what the query is until a branch
   * is resolved. A disabled query is neither loading nor failed, so a check
   * written as "not loading and not an error" would print a positive claim
   * about the shelf from a request that never ran. Reading the rows themselves
   * has no such gap: an array means the server answered. */
  rows: InventoryRow[] | undefined
  failed: boolean
  branchId: string
}) {
  const alerts = stockAlerts(rows)
  const answered = rows !== undefined

  return (
    <Panel
      title="Needs attention"
      icon={AlertTriangle}
      action={
        alerts.length > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {alerts.length} {alerts.length === 1 ? 'product' : 'products'}
          </span>
        ) : undefined
      }
    >
      {!answered ? (
        failed ? (
          // Never the all-clear. "Everything is in stock" on a request that did
          // not come back is the one wrong thing this card can say: it is a
          // positive claim about the shelf made from no information at all.
          <Empty>Stock levels could not be loaded. Refresh to try again.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        )
      ) : rows.length === 0 ? (
        // No rows at all is not the same as no shortages. A branch that carries
        // nothing has no shelf to be in stock, and the read returns an empty set
        // rather than an error to a caller it will not answer -- so the one
        // thing this state must not do is congratulate anybody.
        <Empty>No stock is being tracked for this branch yet.</Empty>
      ) : alerts.length === 0 ? (
        <Empty>Everything on the shelf is in stock.</Empty>
      ) : (
        // Scrolls rather than truncates: a long list must not stretch the
        // dashboard row, and must not be shortened either.
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {failed ? (
            // A refetch failed over levels already in hand. Throwing them away
            // for an error message would lose real shortages; saying nothing
            // would pass stale figures off as current. So: keep them, date them.
            <p className="text-xs text-muted-foreground">
              These levels could not be refreshed just now.
            </p>
          ) : null}
          {alerts.map((alert) => (
            <Link
              key={alert.product_id}
              to={`/pos/stock?branch=${branchId}`}
              className={cn(
                'flex items-center gap-3 rounded-lg border p-3 transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                alert.kind === 'out'
                  ? 'border-destructive/30 bg-destructive/5 hover:bg-destructive/10'
                  : 'border-warning/30 bg-warning/5 hover:bg-warning/10'
              )}
            >
              {/* The label below already says the quantity in words a screen
                  reader can use, so the figure is here to be seen, not read
                  twice. */}
              <span
                aria-hidden="true"
                className={cn(
                  'w-8 shrink-0 text-center font-display text-2xl font-bold leading-none tabular-nums',
                  alert.kind === 'out' ? 'text-destructive' : 'text-warning'
                )}
              >
                {alert.quantity}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {alert.name}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {alert.kind === 'out'
                    ? 'Out of stock'
                    : `Low stock — ${alert.quantity} remaining`}
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          ))}
        </div>
      )}
    </Panel>
  )
}

function Panel({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>
)

export default function PosDashboardPage() {
  const { branchId, setBranchId, managed, isLoading: branchesLoading } = useManagerBranch()

  const { data: day } = useBusinessDay()
  const summary = useDashboardSummary(branchId || undefined)
  const payments = useDashboardPaymentTotals(branchId || undefined)
  const top = useDashboardTopProducts(branchId || undefined)
  const recent = useDashboardRecentSales(branchId || undefined, day?.day_start)
  // The same per-branch stock the Products and Inventory pages read. Stock
  // alerts are a point-in-time fact about the shelf, so they are deliberately
  // not taken from the day-scoped dashboard summary -- and this query key is
  // already invalidated by checkout, receiving and adjustments, so the card
  // refreshes on its own without a new mechanism.
  const inventory = useBranchInventory(branchId || undefined)

  const branchName = managed.find((b) => b.id === branchId)?.name ?? ''
  const stats = summary.data
  const loading = summary.isLoading

  if (!branchesLoading && managed.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          You do not manage a branch, so there is no dashboard to show.
        </CardContent>
      </Card>
    )
  }

  if (summary.isError) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-destructive">
          {describeDashboardError(summary.error)}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">
            {branchName || 'Dashboard'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {/* The day the SERVER used, not the device's idea of today. */}
            {day?.business_date
              ? `Trading today — ${formatBusinessDate(day.business_date)}`
              : 'Trading today'}
          </p>
        </div>
        <ManagerBranchPicker branchId={branchId} onChange={setBranchId} branches={managed} />
      </div>

      {/* The day, in the order a manager asks about it: what came in, how much
          trading it took, and what needs dealing with. */}
      <div className="grid gap-4 lg:grid-cols-4">
        <TakingsCard summary={stats} loading={loading} />

        <div className="flex flex-col gap-4">
          <Figure
            label="Transactions"
            value={String(stats?.transaction_count ?? 0)}
            hint={`${stats?.items_sold ?? 0} items sold`}
            icon={Receipt}
            loading={loading}
          />
          <Figure
            label="Average sale"
            value={formatAverageSale(stats?.average_sale)}
            hint="Across today's transactions"
            icon={TrendingUp}
            loading={loading}
          />
        </div>

        <StockPanel rows={inventory.data} failed={inventory.isError} branchId={branchId} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Top sellers today" icon={Trophy}>
          {top.isLoading ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : (top.data ?? []).length === 0 ? (
            <Empty>Nothing has sold yet today.</Empty>
          ) : (
            <div className="flex flex-col gap-2">
              {(top.data ?? []).map((product, index) => (
                <div
                  key={product.product_id}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {product.product_name}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {peso(product.sales_amount)}
                  </span>
                  <Badge variant="secondary" className="tabular-nums">
                    {product.quantity_sold} sold
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="How today was paid" icon={Wallet}>
          {payments.isLoading ? (
            <div className="flex flex-col gap-2">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : (payments.data ?? []).length === 0 ? (
            <Empty>No payments taken yet today.</Empty>
          ) : (
            <>
              {/* Ordered by size, with each method's share of the day drawn
                  rather than left as arithmetic. "Is the drawer carrying the
                  day or is it the terminal" is the question this panel exists
                  to answer, and a column of amounts does not answer it. */}
              <div className="flex flex-col gap-3">
                {paymentShares(payments.data ?? []).map((row) => (
                  <div key={row.payment_method} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {paymentMethodLabel(row.payment_method)}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {row.transaction_count} {row.transaction_count === 1 ? 'sale' : 'sales'}
                      </span>
                      <span className="shrink-0 font-display text-sm font-semibold tabular-nums text-foreground">
                        {peso(row.amount_collected)}
                      </span>
                    </div>
                    <div
                      className="h-1.5 overflow-hidden rounded-full bg-muted"
                      role="img"
                      aria-label={`${Math.round(row.share)}% of today's takings`}
                    >
                      <div
                        className="h-full rounded-full bg-secondary"
                        style={{ width: `${Math.max(row.share, 1.5)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                {/* A typed GCash or Maya number is what the cashier entered, not
                    money anyone has confirmed arrived. */}
                What customers paid with. An electronic reference recorded at the till is not a
                confirmation that the payment settled.
              </p>
            </>
          )}
        </Panel>
      </div>

      <Panel
        title="Recent sales"
        icon={Receipt}
        action={
          <Button variant="ghost" size="sm" asChild>
            <Link to="/pos/transactions">
              All transactions <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        }
      >
        {recent.isLoading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : (recent.data ?? []).length === 0 ? (
          <Empty>No sales have been rung up yet today.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Cashier</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(recent.data ?? []).map((sale) => (
                  <TableRow key={sale.sale_id}>
                    <TableCell className="whitespace-nowrap">
                      {new Date(sale.created_at).toLocaleTimeString('en-PH', {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </TableCell>
                    {/* The sale's own receipt number, so a manager reading
                        this list and a customer holding the paper are looking
                        at the same reference. */}
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {sale.receipt_number}
                    </TableCell>
                    <TableCell>{sale.cashier_name}</TableCell>
                    <TableCell className="tabular-nums">{sale.item_count}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {peso(Number(sale.total_amount))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
    </div>
  )
}
