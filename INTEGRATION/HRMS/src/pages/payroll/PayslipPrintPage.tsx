import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useSystemSettings } from '@/hooks/useSystemSettings'
import { usePayrollRecord, useMyPayrollRecord, getLatestPayslip, type PayrollRecord } from '@/hooks/usePayroll'
import { HR_PAYROLL_PATH, MY_PAYROLL_PATH } from '@/lib/payslipPaths'
import { formatMoney, type CurrencyCode } from '@/lib/currency'
import { formatMinutesAsDuration, formatHoursAsDuration } from '@/lib/attendanceCalculations'

function formatDate(value: string | null) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
}

/** HR → Payroll → an employee's payslip, inside Human Resources: any record HR
 *  may read. */
export default function PayslipPrintPage() {
  const { recordId } = useParams<{ recordId: string }>()
  const { data: record, isLoading } = usePayrollRecord(recordId)
  return <PayslipView record={record} isLoading={isLoading} back={{ to: HR_PAYROLL_PATH, label: 'Payroll' }} />
}

/** My Workspace → My Payroll → the signed-in person's own payslip, inside My
 *  Workspace -- whatever their role, since an HR Manager is an employee too. */
export function MyPayslipPage() {
  const { recordId } = useParams<{ recordId: string }>()
  const { data: record, isLoading } = useMyPayrollRecord(recordId)
  return <PayslipView record={record} isLoading={isLoading} back={{ to: MY_PAYROLL_PATH, label: 'My Payroll' }} />
}

/**
 * The payslip itself, shared by both. Back used to be chosen from the viewer's
 * role, which sent an HR Manager reading their own payslip back to HR Payroll;
 * it now comes from the page that opened it, the same way the shell comes from
 * the address.
 */
function PayslipView({
  record,
  isLoading,
  back,
}: {
  record: PayrollRecord | null | undefined
  isLoading: boolean
  back: { to: string; label: string }
}) {
  const { data: settings } = useSystemSettings()

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="mt-6 h-96 w-full" />
      </div>
    )
  }

  const payslip = record ? getLatestPayslip(record) : null

  if (!record || !payslip) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 px-6 py-24 text-center">
        <h1 className="font-display text-2xl font-bold text-foreground">Payslip not available</h1>
        <p className="text-muted-foreground">This payroll record doesn't have a released payslip yet.</p>
        <Button asChild variant="outline">
          <Link to={back.to}>
            <ArrowLeft className="h-4 w-4" />
            Back to {back.label}
          </Link>
        </Button>
      </div>
    )
  }

  const applicant = record.employees
  const currency = record.currency as CurrencyCode
  const companyName = settings?.company_name || 'JMAC Enterprise'
  const allowanceItems = record.payroll_line_items.filter((i) => i.item_type === 'allowance')
  const deductionItems = record.payroll_line_items.filter((i) => i.item_type === 'deduction')

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 print:p-0">
      <div className="mb-6 flex items-center justify-between print:hidden">
        <Button asChild variant="outline" size="sm">
          <Link to={back.to}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <Button size="sm" onClick={() => window.print()}>
          <Printer className="h-4 w-4" />
          Print / Save as PDF
        </Button>
      </div>

      <article className="flex flex-col gap-8 rounded-xl border border-border bg-card p-10 shadow-sm print:rounded-none print:border-0 print:shadow-none">
        <header className="flex flex-col items-center gap-1 border-b border-border pb-6 text-center">
          <h1 className="font-display text-2xl font-bold text-foreground">{companyName}</h1>
          <p className="text-sm text-muted-foreground">Payslip — {payslip.payslip_number}</p>
        </header>

        <section className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Employee Name</p>
            <p className="text-foreground">
              {applicant.first_name} {applicant.last_name}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Employee ID</p>
            <p className="text-foreground">{applicant.employee_number}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Department</p>
            <p className="text-foreground">{applicant.departments?.name ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Position</p>
            <p className="text-foreground">{applicant.positions?.title ?? '—'}</p>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payroll Date</p>
            <p className="text-foreground">{formatDate(payslip.released_at)}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Currency</p>
            <p className="text-foreground">{currency}</p>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Present Days</p>
            <p className="text-foreground">{Number(record.days_present)}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Absent Days</p>
            <p className="text-foreground">{Number(record.absent_days)}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Late</p>
            <p className="text-foreground">{formatMinutesAsDuration(record.late_minutes)}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Overtime</p>
            <p className="text-foreground">{formatHoursAsDuration(Number(record.overtime_hours))}</p>
          </div>
        </section>

        <section className="flex flex-col gap-2 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Earnings</p>
          <div className="flex items-center justify-between">
            <span className="text-foreground">Basic Salary</span>
            <span className="text-foreground">{formatMoney(Number(record.basic_salary), currency)}</span>
          </div>
          {allowanceItems.map((item) => (
            <div key={item.id} className="flex items-center justify-between">
              <span className="text-foreground">{item.label}</span>
              <span className="text-foreground">{formatMoney(Number(item.amount), currency)}</span>
            </div>
          ))}
          <div className="flex items-center justify-between border-t border-border pt-2 font-medium">
            <span className="text-foreground">Gross Salary</span>
            <span className="text-foreground">{formatMoney(Number(record.gross_salary), currency)}</span>
          </div>
        </section>

        <section className="flex flex-col gap-2 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Deductions</p>
          {deductionItems.length > 0 ? (
            deductionItems.map((item) => (
              <div key={item.id} className="flex items-center justify-between">
                <span className="text-foreground">{item.label}</span>
                <span className="text-foreground">-{formatMoney(Number(item.amount), currency)}</span>
              </div>
            ))
          ) : (
            <p className="text-muted-foreground">No deductions</p>
          )}
          <div className="flex items-center justify-between border-t border-border pt-2 font-medium">
            <span className="text-foreground">Total Deductions</span>
            <span className="text-foreground">-{formatMoney(Number(record.total_deductions), currency)}</span>
          </div>
        </section>

        <section className="flex items-center justify-between rounded-lg bg-accent/10 p-4">
          <span className="font-display text-lg font-bold text-foreground">Net Salary</span>
          <span className="font-display text-lg font-bold text-teal-ink">{formatMoney(Number(record.net_salary), currency)}</span>
        </section>

        <section className="mt-8 grid grid-cols-2 gap-10 text-sm">
          <div className="flex flex-col gap-8">
            <div className="border-b border-foreground/40 pb-1" />
            <div>
              <p className="font-medium text-foreground">HR Signature</p>
              <p className="text-xs text-muted-foreground">JMAC Enterprise HR</p>
            </div>
          </div>
          <div className="flex flex-col gap-8">
            <div className="border-b border-foreground/40 pb-1" />
            <div>
              <p className="font-medium text-foreground">
                {applicant.first_name} {applicant.last_name}
              </p>
              <p className="text-xs text-muted-foreground">Employee</p>
            </div>
          </div>
        </section>
      </article>
    </div>
  )
}
