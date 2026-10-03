import { formatMoney } from '@/lib/currency'
import { errorMessage } from '@/lib/errorMessage'

/**
 * Payroll, from Finance's side of the boundary.
 *
 * HRMS owns the calculation. A payroll period becomes finalized when every one
 * of its records is released, and at that moment Finance receives an immutable
 * snapshot of what HR finalized. Nothing here computes gross, deductions or
 * net — those are copies, and the reason for copying rather than joining is
 * auditability: Finance pays what HR finalized, and can still show what that
 * was a year later.
 *
 * There is no FMS control that edits payroll. If a figure is wrong, it is
 * wrong in HR, and HR is where it gets corrected.
 */

export const PAYROLL_FINANCE_KEY = ['payroll-finance'] as const

export interface PayrollFinanceBatch {
  id: string
  batch_no: string | null
  source_payroll_period_id: string
  period_start: string
  period_end: string
  pay_date: string | null
  frequency: string | null
  employee_count: number
  gross_total: number
  deductions_total: number
  net_total: number
  amount_paid: number
  balance_due: number
  pending_disbursement: number
  available_to_prepare: number
  settlement_state: 'awaiting_disbursement' | 'partially_paid' | 'paid'
  source_finalized_at: string | null
  created_at: string
}

export interface PayrollFinanceItem {
  id: string
  employee_id: string
  employee_name: string | null
  gross_amount: number
  deductions_amount: number
  net_amount: number
}

export type DisbursementStatus =
  | 'draft'
  | 'for_approval'
  | 'approved'
  | 'paid'
  | 'returned'
  | 'rejected'

export interface PayrollDisbursement {
  id: string
  disbursement_no: string | null
  batch_id: string
  batch_no: string | null
  treasury_account_id: string
  account_name: string | null
  amount: number
  method: string
  payment_date: string | null
  reference: string | null
  notes: string | null
  status: DisbursementStatus
  prepared_by: string | null
  prepared_by_name: string | null
  approved_by_name: string | null
  approved_at: string | null
  paid_by_name: string | null
  paid_at: string | null
  decision_reason: string | null
  created_at: string
}

export const DISBURSEMENT_STATUS_LABEL: Record<DisbursementStatus, string> = {
  draft: 'Draft',
  for_approval: 'With the Finance Manager',
  approved: 'Approved for payment — not yet sent',
  paid: 'Paid',
  returned: 'Returned for correction',
  rejected: 'Rejected',
}

export const PAYROLL_SETTLEMENT_LABEL: Record<string, string> = {
  awaiting_disbursement: 'Awaiting disbursement',
  partially_paid: 'Partially paid',
  paid: 'Paid',
}

/** The pay period, said the way a payslip says it. */
export function formatPayPeriod(batch: { period_start: string; period_end: string }): string {
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(`${iso}T00:00:00+08:00`))
  return `${fmt(batch.period_start)} – ${fmt(batch.period_end)}`
}

export function canPrepareDisbursement(
  batch: { available_to_prepare?: number | string | null },
  role: string | undefined
): boolean {
  return role === 'accountant' && Number(batch.available_to_prepare ?? 0) > 0
}

export function roomForDisbursement(
  disbursement: PayrollDisbursement,
  siblings: PayrollDisbursement[],
  balanceDue: number
): number {
  const claimed = siblings
    .filter((o) => o.id !== disbursement.id && ['draft', 'for_approval', 'approved'].includes(o.status))
    .reduce((sum, o) => sum + Number(o.amount ?? 0), 0)
  return Math.max(balanceDue - claimed, 0)
}

export function disbursementActionsFor(
  disbursement: PayrollDisbursement,
  role: string | undefined,
  userId: string | undefined,
  availableForThis?: number
): { canSubmit: boolean; canDecide: boolean; canRecord: boolean } {
  const isAccountant = role === 'accountant'
  const fits = availableForThis === undefined || Number(disbursement.amount) <= availableForThis
  return {
    canSubmit:
      isAccountant &&
      (disbursement.status === 'draft' || disbursement.status === 'returned') &&
      fits,
    canDecide:
      role === 'finance_manager' &&
      disbursement.status === 'for_approval' &&
      disbursement.prepared_by !== userId,
    canRecord: isAccountant && disbursement.status === 'approved',
  }
}

/**
 * Said on the payroll page, because the boundary is the point.
 *
 * A Finance user looking at these figures should know they are looking at a
 * copy, and that the place to change one is not here.
 */
export const SNAPSHOT_NOTE =
  'These figures are a snapshot of what HR released for this period. Finance ' +
  'does not calculate payroll and cannot change it here — a correction has to ' +
  'be made in HR, and would arrive as a new payable.'

/**
 * Why payroll does not touch a budget.
 *
 * HR payroll carries no budget linkage — neither payroll_periods nor
 * payroll_records names one — so there is no authoritative source to consume,
 * and inventing one would be fabricating accounting.
 */
export const BUDGET_NEUTRAL_NOTE =
  'Payroll is not charged to a procurement budget. HR payroll records no ' +
  'budget, so a disbursement moves treasury only.'

export function formatPayrollMoney(value: number | null | undefined): string {
  return formatMoney(Number(value ?? 0))
}

export function describePayrollError(error: unknown): string {
  const message = errorMessage(error)
  return message || 'That could not be completed. Please try again.'
}
