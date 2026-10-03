import { useNavigate } from 'react-router-dom'
import type { ColumnDef } from '@tanstack/react-table'
import { FileText } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useMyPayrollRecords, useMyPortalRealtimeAlerts, type MyPayrollRecord } from '@/hooks/useEmployeePortal'
import { getLatestPayslip } from '@/hooks/usePayroll'
import { PAYROLL_STATUS_LABEL, PAYROLL_STATUS_VARIANT } from '@/lib/payrollLabels'
import { myPayslipPath } from '@/lib/payslipPaths'
import { formatMoney, type CurrencyCode } from '@/lib/currency'

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function MyPayrollPage() {
  useMyPortalRealtimeAlerts()
  const navigate = useNavigate()
  const { data: records, isLoading, isError } = useMyPayrollRecords()

  const columns: ColumnDef<MyPayrollRecord>[] = [
    {
      id: 'period',
      header: 'Payroll Period',
      cell: ({ row }) =>
        row.original.payroll_periods
          ? `${formatDate(row.original.payroll_periods.period_start)} – ${formatDate(row.original.payroll_periods.period_end)}`
          : '—',
    },
    { id: 'gross', header: 'Gross Salary', cell: ({ row }) => formatMoney(Number(row.original.gross_salary), row.original.currency as CurrencyCode) },
    { id: 'deductions', header: 'Deductions', cell: ({ row }) => formatMoney(Number(row.original.total_deductions), row.original.currency as CurrencyCode) },
    { id: 'net', header: 'Net Salary', cell: ({ row }) => formatMoney(Number(row.original.net_salary), row.original.currency as CurrencyCode) },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => <Badge variant={PAYROLL_STATUS_VARIANT[row.original.status]}>{PAYROLL_STATUS_LABEL[row.original.status]}</Badge>,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const payslip = getLatestPayslip(row.original)
        return payslip ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              // My Workspace's own address for it, not HR's: the shell follows
              // the address, and this one keeps the employee where they are.
              navigate(myPayslipPath(row.original.id))
            }}
          >
            <FileText className="h-4 w-4" />
            View Payslip
          </Button>
        ) : null
      },
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-xl font-semibold text-foreground">My Payroll</h2>
        <p className="text-sm text-muted-foreground">Review your payroll history and released payslips.</p>
      </div>

      {isError ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <p className="font-medium text-foreground">Couldn't load your payroll records</p>
          <p className="text-sm text-muted-foreground">Please refresh the page or try again shortly.</p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={records ?? []}
          isLoading={isLoading}
          density="compact"
          searchPlaceholder="Search..."
          emptyTitle="No payslips yet"
          emptyDescription="Your payslip appears here once HR has approved and released that period's payroll."
        />
      )}
    </div>
  )
}
