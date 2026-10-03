import { useNavigate } from 'react-router-dom'
import { Printer } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetBody, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { usePayrollRecord, getLatestPayslip } from '@/hooks/usePayroll'
import { PAYROLL_STATUS_LABEL, PAYROLL_STATUS_VARIANT } from '@/lib/payrollLabels'
import { hrPayslipPath } from '@/lib/payslipPaths'
import { formatMoney, type CurrencyCode } from '@/lib/currency'
import { formatMinutesAsDuration, formatHoursAsDuration } from '@/lib/attendanceCalculations'

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value || '—'}</p>
    </div>
  )
}

function AmountRow({ label, value, currency, emphasis }: { label: string; value: number; currency: CurrencyCode; emphasis?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={emphasis ? 'font-medium text-foreground' : 'text-muted-foreground'}>{label}</span>
      <span className={emphasis ? 'font-display font-bold text-foreground' : 'text-foreground'}>{formatMoney(value, currency)}</span>
    </div>
  )
}

export function PayrollDetailsSheet({
  recordId,
  open,
  onOpenChange,
}: {
  recordId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const { data: record, isLoading } = usePayrollRecord(recordId ?? undefined)
  const currency = (record?.currency as CurrencyCode) ?? 'PHP'
  const payslip = record ? getLatestPayslip(record) : null

  const allowanceItems = record?.payroll_line_items.filter((i) => i.item_type === 'allowance') ?? []
  const deductionItems = record?.payroll_line_items.filter((i) => i.item_type === 'deduction') ?? []

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        {isLoading || !record ? (
          <SheetBody>
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="mt-4 h-64 w-full" />
          </SheetBody>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle>
                {record.employees.first_name} {record.employees.last_name}
              </SheetTitle>
              <SheetDescription>Payroll record</SheetDescription>
            </SheetHeader>
            <SheetBody>
              <div className="flex flex-col gap-6">
                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Employee Information</h3>
                  <div className="grid grid-cols-2 gap-4 rounded-lg border border-border p-3">
                    <Field label="Employee ID" value={record.employees.employee_number} />
                    <Field label="Employee Name" value={`${record.employees.first_name} ${record.employees.last_name}`} />
                    <Field label="Department" value={record.employees.departments?.name ?? ''} />
                    <Field label="Position" value={record.employees.positions?.title ?? ''} />
                  </div>
                </section>

                <section className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</h3>
                    <Badge variant={PAYROLL_STATUS_VARIANT[record.status]}>{PAYROLL_STATUS_LABEL[record.status]}</Badge>
                  </div>
                  {payslip && (
                    <Button variant="outline" size="sm" onClick={() => navigate(hrPayslipPath(record.id))}>
                      <Printer className="h-3.5 w-3.5" />
                      View / Print Payslip ({payslip.payslip_number})
                    </Button>
                  )}
                </section>

                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Attendance Summary</h3>
                  <div className="grid grid-cols-2 gap-4 rounded-lg border border-border p-3">
                    <Field label="Present Days" value={String(Number(record.days_present))} />
                    <Field label="Absent Days" value={String(Number(record.absent_days))} />
                    <Field label="Late" value={formatMinutesAsDuration(record.late_minutes)} />
                    <Field label="Undertime" value={formatMinutesAsDuration(record.undertime_minutes)} />
                    <Field label="Overtime Hours" value={formatHoursAsDuration(Number(record.overtime_hours))} />
                    <Field label="Working Days" value={String(Number(record.working_days))} />
                  </div>
                </section>

                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Leave Summary</h3>
                  <div className="grid grid-cols-2 gap-4 rounded-lg border border-border p-3">
                    <Field label="Paid Leave Days" value={String(Number(record.paid_leave_days))} />
                    <Field label="Leave Without Pay Days" value={String(Number(record.unpaid_leave_days))} />
                  </div>
                </section>

                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Salary Breakdown</h3>
                  <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                    <AmountRow label="Basic Salary" value={Number(record.basic_salary)} currency={currency} />
                    {allowanceItems.map((item) => (
                      <AmountRow key={item.id} label={item.label} value={Number(item.amount)} currency={currency} />
                    ))}
                    <div className="border-t border-border pt-2">
                      <AmountRow label="Gross Salary" value={Number(record.gross_salary)} currency={currency} emphasis />
                    </div>
                    <div className="mt-2 border-t border-border pt-2">
                      {deductionItems.map((item) => (
                        <AmountRow key={item.id} label={item.label} value={-Number(item.amount)} currency={currency} />
                      ))}
                      <AmountRow label="Total Deductions" value={-Number(record.total_deductions)} currency={currency} />
                    </div>
                    <div className="border-t border-border pt-2">
                      <AmountRow label="Net Salary" value={Number(record.net_salary)} currency={currency} emphasis />
                    </div>
                  </div>
                </section>

                {record.notes && (
                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</h3>
                    <p className="rounded-lg border border-border p-3 text-sm text-foreground">{record.notes}</p>
                  </section>
                )}
              </div>
            </SheetBody>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
