import * as React from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AlertTriangle, Info } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { PosInventoryHeader } from '@/components/pos/PosInventoryHeader'
import { useAuth } from '@/contexts/AuthContext'
import { useBranches } from '@/hooks/useBranches'
import { useBranchInventory, useBranchMovements, useSetLowStockThreshold } from '@/hooks/usePosInventory'
import { MOVEMENT_LABEL, inventoryConcernRank, type InventoryRow } from '@/lib/posInventory'
import { isPosManagerAt } from '@/lib/portals'

/**
 * Branch stock, as POS staff see it.
 *
 * Nothing here can show cost: `get_branch_inventory` and `get_branch_movements`
 * declare no cost column, so there is nothing to leak even if this page tried.
 * The Administrator-only valuation lives on the back-office Inventory screen.
 *
 * Both RPCs are POS-Manager-gated in the database. A cashier calling them gets
 * an empty set, which is why this page explains itself rather than showing an
 * empty table -- a cashier reads stock on the POS screen instead.
 *
 * A manager may set a low-stock level here. Nothing else: receiving and
 * adjusting are Administrator-only in this phase, and the product master --
 * names, prices, cost, categories -- is enterprise administration they have no
 * path to.
 *
 * Whether a product is offered is shown here but changed on Products. The
 * switch lived on this page for a while, because a separate Catalogue page had
 * shown the same products with no clear owner. Products now owns the catalogue
 * questions and this page owns the quantity ones, which is the split that
 * actually keeps them apart.
 */
export default function PosStockPage() {
  const { profile, posAccess } = useAuth()
  const { data: branches } = useBranches()
  const isAdministrator = profile?.role === 'admin'

  const myBranches = React.useMemo(() => {
    const active = (branches ?? []).filter((b) => b.is_active)
    return isAdministrator ? active : active.filter((b) => posAccess.branchIds.includes(b.id))
  }, [branches, posAccess.branchIds, isAdministrator])

  // ?history=1 is how the Requests tab's History button gets here; the two
  // views share one history implementation rather than each having its own.
  // ?branch= is how the dashboard's stock alerts arrive, naming the branch
  // whose shelf raised them.
  const [searchParams] = useSearchParams()
  const requestedBranch = searchParams.get('branch')

  const [branchId, setBranchId] = React.useState('')
  React.useEffect(() => {
    if (branchId || myBranches.length === 0) return
    // Honoured only when the account actually holds that branch: myBranches is
    // already filtered by access, so a hand-edited query string falls through
    // to the default rather than granting anything.
    const requested = myBranches.find((b) => b.id === requestedBranch)
    setBranchId(requested?.id ?? myBranches[0].id)
  }, [branchId, myBranches, requestedBranch])

  const { data: rows, isLoading } = useBranchInventory(branchId || undefined)
  const [showHistory, setShowHistory] = React.useState(searchParams.get('history') === '1')
  const { data: movements } = useBranchMovements(branchId || undefined, showHistory)
  const setThreshold = useSetLowStockThreshold()

  // Per branch, never a global flag: the same person can manage one branch and
  // cash up at another, and the offered switch belongs only to the branch they
  // actually manage. The database refuses the write regardless -- the trigger
  // on pos_branch_products lets a manager move nothing but is_available, and
  // only at a branch they hold.
  const managesThisBranch = isAdministrator || isPosManagerAt(posAccess, branchId)

  const sorted = React.useMemo(
    () =>
      [...(rows ?? [])].sort(
        (a, b) =>
          inventoryConcernRank(a) - inventoryConcernRank(b) ||
          a.product_name.localeCompare(b.product_name)
      ),
    [rows]
  )

  if (myBranches.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          You are not assigned to a branch yet.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PosInventoryHeader
        description="Manage branch stock and inventory requests."
        showTabs={!isAdministrator}
        branchId={branchId}
        historyOpen={showHistory}
        onToggleHistory={() => setShowHistory((open) => !open)}
        branchPicker={
          myBranches.length > 1 ? (
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger className="w-52" aria-label="Branch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {myBranches.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : undefined
        }
      />

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Receiving a delivery and correcting a count are done by an Administrator. Here you can set
          the level at which a product is flagged as low, and stop or resume offering it at this
          branch.
        </p>
      </div>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : sorted.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            {/* Zero rows has two completely different causes and used to have
                one message. A manager of an empty branch was told there was no
                stock view for their account -- which reads as "you are not
                allowed here" -- when the truth was that the branch had nothing
                in it yet. managesThisBranch separates them, using the same
                predicate the database uses, so the screen and the server agree
                about which of the two it is. */}
            {managesThisBranch ? (
              <>
                <p className="text-sm text-foreground">
                  No products are stocked at this branch yet.
                </p>
                <p className="max-w-md text-xs text-muted-foreground">
                  Ask to carry a product the business already sells, or propose a new one. Stock
                  arrives later, when a request is received.
                </p>
                <Button asChild size="sm" className="mt-2">
                  <Link to={branchId ? `/pos/requests?branch=${branchId}` : '/pos/requests'}>
                    New request
                  </Link>
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  There is no stock view for this account.
                </p>
                <p className="max-w-md text-xs text-muted-foreground">
                  Stock levels for the products you sell are shown on the POS screen, next to each
                  product. This page is for the branch's POS Manager.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>On hand</TableHead>
                <TableHead>Low at</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Offered</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((row: InventoryRow) => (
                <TableRow key={row.product_id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium text-foreground">{row.product_name}</span>
                      <span className="text-xs text-muted-foreground">{row.category_name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums">{row.quantity_on_hand}</TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min={0}
                      step="1"
                      className="h-8 w-20"
                      aria-label={`Low-stock level for ${row.product_name}`}
                      // set_low_stock_threshold is manager-gated in the
                      // database; disabling here just says so first.
                      disabled={!managesThisBranch}
                      defaultValue={row.low_stock_threshold}
                      onBlur={(e) => {
                        const next = Number(e.target.value)
                        if (Number.isInteger(next) && next >= 0 && next !== row.low_stock_threshold) {
                          setThreshold.mutate({ branchId, productId: row.product_id, threshold: next })
                        }
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    {row.quantity_on_hand === 0 ? (
                      <Badge variant="destructive">Out of stock</Badge>
                    ) : row.is_low_stock ? (
                      <Badge variant="warning">
                        <AlertTriangle className="h-3 w-3" />
                        Low
                      </Badge>
                    ) : (
                      <Badge variant="success">In stock</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {/* Shown, not switched. The offered toggle moved to
                        Products when that page was added: this screen answers
                        "how many", Products answers "what do we sell". Two
                        screens owning one control is the ambiguity that put
                        this switch here in the first place. */}
                    <Badge variant={row.is_available ? 'outline' : 'muted'}>
                      {row.is_available ? 'Offered' : 'Stopped'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {showHistory && sorted.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-3 py-5">
            <h3 className="font-medium text-foreground">Movement history</h3>
            {(movements ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing has moved at this branch yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Movement</TableHead>
                      <TableHead>Change</TableHead>
                      <TableHead>Balance</TableHead>
                      <TableHead>By</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(movements ?? []).map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {new Date(m.created_at).toLocaleString()}
                        </TableCell>
                        <TableCell>{m.product_name}</TableCell>
                        <TableCell>
                          <Badge variant={m.quantity_change > 0 ? 'success' : 'muted'}>
                            {MOVEMENT_LABEL[m.movement_type]}
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {m.quantity_change > 0 ? `+${m.quantity_change}` : m.quantity_change}
                        </TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">
                          {m.stock_before} → {m.stock_after}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {m.actor_name ?? 'Unknown'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
