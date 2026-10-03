import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { Info, Users, Wallet } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAuth } from '@/contexts/AuthContext'
import { formatMoney } from '@/lib/currency'
import { DisbursementPanel, PrepareDialog } from '@/components/fms/DisbursementPanel'
import {
  useCreateDisbursement,
  usePayrollDisbursements,
  usePayrollFinanceBatches,
  usePayrollFinanceItems,
  useTransitionDisbursement,
} from '@/hooks/usePayrollFinance'
import {
  BUDGET_NEUTRAL_NOTE,
  DISBURSEMENT_STATUS_LABEL,
  PAYROLL_SETTLEMENT_LABEL,
  SNAPSHOT_NOTE,
  canPrepareDisbursement,
  describePayrollError,
  disbursementActionsFor,
  formatPayPeriod,
  roomForDisbursement,
  type PayrollFinanceBatch,
} from '@/lib/payrollFinance'

/**
 * Payroll Finance: paying what HR finalized.
 *
 * Every figure on this page is a snapshot taken when HR released the period.
 * There is no control here that edits a payroll record, a period or a payslip,
 * and there is not meant to be — FMS owns the financial consequence, and HR
 * owns the calculation that produced it.
 *
 * The batch arrives on its own, written by a database trigger when HR
 * finalizes. Nothing on this page creates one.
 */
export default function PayrollFinancePage() {
  const { data: batches = [], isLoading, isError, error } = usePayrollFinanceBatches()
  const [openId, setOpenId] = React.useState<string | null>(null)

  const awaiting = batches.filter((b) => b.settlement_state !== 'paid')
  const owed = awaiting.reduce((sum, b) => sum + Number(b.balance_due ?? 0), 0)
  const heads = awaiting.reduce((sum, b) => sum + Number(b.employee_count ?? 0), 0)

  const columns = React.useMemo<ColumnDef<PayrollFinanceBatch>[]>(
    () => [
      {
        accessorKey: 'batch_no',
        header: 'Payroll',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-foreground">{row.original.batch_no}</p>
            <p className="truncate text-xs text-muted-foreground">
              {formatPayPeriod(row.original)}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'employee_count',
        header: () => <div className="text-right">Employees</div>,
        cell: ({ row }) => (
          <div className="text-right tabular-nums">{row.original.employee_count}</div>
        ),
      },
      {
        accessorKey: 'gross_total',
        header: () => <div className="text-right">Gross</div>,
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            {formatMoney(Number(row.original.gross_total))}
          </div>
        ),
      },
      {
        accessorKey: 'deductions_total',
        header: () => <div className="text-right">Deductions</div>,
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            −{formatMoney(Number(row.original.deductions_total))}
          </div>
        ),
      },
      {
        accessorKey: 'net_total',
        header: () => <div className="text-right">Net payable</div>,
        cell: ({ row }) => (
          <div className="text-right font-medium tabular-nums">
            {formatMoney(Number(row.original.net_total))}
          </div>
        ),
      },
      {
        accessorKey: 'balance_due',
        header: () => <div className="text-right">Balance</div>,
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            {formatMoney(Number(row.original.balance_due))}
          </div>
        ),
      },
      {
        accessorKey: 'settlement_state',
        header: 'Status',
        cell: ({ row }) => (
          <Badge
            variant={row.original.settlement_state === 'paid' ? 'default' : 'secondary'}
            className="font-normal"
          >
            {PAYROLL_SETTLEMENT_LABEL[row.original.settlement_state]}
          </Badge>
        ),
      },
    ],
    []
  )

  return (
    <div className="space-y-6">
      {/* "Released", HR's word for the step -- the button HR presses says
        * Release, and a payroll exists here from that moment and not before. */}
      <PageHeader
        title="Payroll Finance"
        description="Released payroll, ready to be disbursed. HR owns the figures; Finance pays them."
      />

      {isError && (
        <Card className="border-destructive/40">
          <CardContent className="py-4 text-sm text-destructive">
            {describePayrollError(error)}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {/* isError: a failed load leaves `batches` empty, and these would
          * otherwise read 0, 0 and ₱0.00 -- indistinguishable from a genuinely
          * quiet payroll. */}
        <StatCard
          label="Awaiting disbursement"
          value={awaiting.length}
          icon={Wallet}
          isLoading={isLoading}
          isError={isError}
          index={0}
        />
        <StatCard
          label="Employees to pay"
          value={heads}
          icon={Users}
          isLoading={isLoading}
          isError={isError}
          index={1}
        />
        <StatCard
          label="Net still owing"
          value={formatMoney(owed)}
          icon={Wallet}
          isLoading={isLoading}
          isError={isError}
          index={2}
        />
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{SNAPSHOT_NOTE}</p>
      </div>

      {/* Not rendered when the load failed: its empty state would claim there
        * is nothing to pay, which a failure does not know. The error above is
        * the whole answer. */}
      {!isError && (
        <DataTable
          columns={columns}
          data={batches}
          isLoading={isLoading}
          searchPlaceholder="Search payroll…"
          emptyTitle="No payroll to disburse"
          emptyDescription="A payroll appears here as soon as HR releases a payroll period — once every employee is approved and the HR Manager releases it."
          density="compact"
          onRowClick={(row) => setOpenId(row.id)}
        />
      )}

      <PayrollBatchDetail
        batch={batches.find((b) => b.id === openId) ?? null}
        onOpenChange={(open) => !open && setOpenId(null)}
      />
    </div>
  )
}

function PayrollBatchDetail({
  batch,
  onOpenChange,
}: {
  batch: PayrollFinanceBatch | null
  onOpenChange: (open: boolean) => void
}) {
  const { profile } = useAuth()
  const { data: items = [] } = usePayrollFinanceItems(batch?.id ?? null)
  const { data: disbursements = [] } = usePayrollDisbursements(batch?.id ?? null)
  const create = useCreateDisbursement()
  const transition = useTransitionDisbursement()
  const [preparing, setPreparing] = React.useState(false)

  if (!batch) return null

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {batch.batch_no}
            <Badge variant="secondary" className="font-normal">
              {PAYROLL_SETTLEMENT_LABEL[batch.settlement_state]}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {formatPayPeriod(batch)} · {batch.employee_count} employees
            {batch.pay_date ? ` · pay date ${batch.pay_date}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* What HR finalized. Read-only, and no control here changes it. */}
          <Card>
            <CardContent className="grid gap-x-6 gap-y-2 py-3 sm:grid-cols-3">
              <Figure label="Gross" value={formatMoney(Number(batch.gross_total))} />
              <Figure label="Deductions" value={formatMoney(Number(batch.deductions_total))} />
              <Figure label="Net payable" value={formatMoney(Number(batch.net_total))} strong />
            </CardContent>
          </Card>

          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <p>{BUDGET_NEUTRAL_NOTE}</p>
          </div>

          {items.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-semibold text-foreground">Employees</p>
              <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {items.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="truncate text-sm text-foreground">
                      {i.employee_name ?? 'Employee'}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-foreground">
                      {formatMoney(Number(i.net_amount))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <DisbursementPanel
            title="Prepare disbursement"
            totals={[
              { label: 'Paid so far', value: Number(batch.amount_paid) },
              { label: 'Pending', value: Number(batch.pending_disbursement) },
              { label: 'Balance due', value: Number(batch.balance_due), strong: true },
              { label: 'Available to prepare', value: Number(batch.available_to_prepare) },
            ]}
            canPrepare={canPrepareDisbursement(batch, profile?.role)}
            fullyInstructedNote={
              profile?.role === 'accountant' && Number(batch.balance_due) > 0
                ? 'The remaining balance is already covered by disbursement instructions.'
                : undefined
            }
            approvalNote="Approving authorises the disbursement. Money leaves only when the Accountant records the completed transfer."
            rows={disbursements.map((d) => {
              const room = roomForDisbursement(d, disbursements, Number(batch.balance_due))
              const can = disbursementActionsFor(d, profile?.role, profile?.id, room)
              return {
                id: d.id,
                number: d.disbursement_no,
                status: d.status,
                statusLabel: DISBURSEMENT_STATUS_LABEL[d.status],
                amount: Number(d.amount),
                method: d.method,
                accountName: d.account_name,
                paymentDate: d.payment_date,
                reference: d.reference,
                decisionReason: d.decision_reason,
                canSubmit: can.canSubmit,
                canDecide: can.canDecide,
                canRecord: can.canRecord,
                stranded:
                  d.status === 'returned' &&
                  profile?.role === 'accountant' &&
                  Number(d.amount) > room,
              }
            })}
            onPrepare={() => setPreparing(true)}
            onSubmit={(id) => transition.mutate({ id, to: 'for_approval' })}
            onApprove={(id) => transition.mutate({ id, to: 'approved' })}
            onReturn={(id, reason) => transition.mutate({ id, to: 'returned', reason })}
            onRecord={(id, reference, paymentDate) =>
              transition.mutate({ id, to: 'paid', reference, paymentDate })
            }
          />
        </div>

        <PrepareDialog
          open={preparing}
          onOpenChange={setPreparing}
          heading="Prepare a payroll disbursement"
          subject={`${batch.batch_no} · ${formatPayPeriod(batch)}`}
          balanceDue={Number(batch.balance_due)}
          pending={Number(batch.pending_disbursement)}
          available={Number(batch.available_to_prepare)}
          onSave={(input) =>
            create.mutate({
              batchId: batch.id,
              accountId: input.accountId,
              amount: input.amount,
              method: input.method,
              submit: input.submit,
            })
          }
        />
      </DialogContent>
    </Dialog>
  )
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          strong
            ? 'font-display text-lg font-bold tabular-nums text-foreground'
            : 'text-sm tabular-nums text-foreground'
        }
      >
        {value}
      </p>
    </div>
  )
}
