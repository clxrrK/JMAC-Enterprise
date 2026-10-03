import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

/**
 * Where a payroll is, and when Finance gets it.
 *
 * Production reported "HR approved the payroll but Finance received nothing".
 * The database said otherwise: one of eight employees had been approved, seven
 * were still awaiting a decision, and nothing had been released. Approval in
 * JMAC is per employee, and Finance receives a payroll only when the HR Manager
 * RELEASES the period -- release_payroll_period issues the payslips and creates
 * Finance's snapshot in one transaction. The pipeline was intact. What the page
 * never said, at any step, was that Finance is waiting on the release.
 */

const PERIOD = 'de11348f-c676-43ed-ae38-2d0d8f680f48'

type Status = 'generated' | 'pending_approval' | 'approved' | 'rejected' | 'released'

const state: {
  role: string
  periodStatus: Status
  recordStatuses: Status[]
} = { role: 'hr_manager', periodStatus: 'pending_approval', recordStatuses: [] }

/** The production period's shape: eight employees, one approved, seven pending. */
const PRODUCTION_STATUSES: Status[] = ['approved', ...Array<Status>(7).fill('pending_approval')]

const record = (status: Status, i: number) => ({
  id: `r${i}`,
  payroll_period_id: PERIOD,
  status,
  basic_salary: 50000,
  gross_salary: 44375,
  total_deductions: 25807.95,
  net_salary: 18567.05,
  currency: 'PHP',
  rejection_reason: null,
  employees: {
    employee_number: `EMP-${i}`,
    first_name: 'Employee',
    last_name: String(i),
    department_id: 'd1',
    position_id: 'p1',
    employment_type: 'regular',
    departments: { name: 'Operations' },
  },
})

const releaseMutate = vi.fn()

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'u1', role: state.role } }),
}))

vi.mock('@/hooks/usePayroll', () => ({
  usePayrollRealtimeAlerts: () => {},
  usePayrollPeriods: () => ({
    data: [
      {
        id: PERIOD,
        period_start: '2026-09-01',
        period_end: '2026-10-31',
        pay_date: '2026-10-01',
        frequency: 'monthly',
        status: state.periodStatus,
      },
    ],
    isLoading: false,
  }),
  usePayrollRecords: () => ({
    data: state.recordStatuses.map(record),
    isLoading: false,
    isError: false,
  }),
  usePayrollPeriodStats: () => ({
    data: {
      employeesIncluded: state.recordStatuses.length,
      grossPayroll: 355000,
      totalDeductions: 210457.92,
      totalNetPayroll: 144542.08,
      payslipsReleased: state.recordStatuses.filter((s) => s === 'released').length,
    },
    isLoading: false,
  }),
  useGeneratePayroll: () => ({ mutate: vi.fn(), isPending: false }),
  useSubmitPayrollForApproval: () => ({ mutate: vi.fn(), isPending: false }),
  useApprovePayrollRecord: () => ({ mutate: vi.fn(), isPending: false }),
  useReleasePayroll: () => ({ mutate: releaseMutate, isPending: false }),
}))

vi.mock('@/hooks/useDepartments', () => ({ useDepartments: () => ({ data: [] }) }))
vi.mock('@/hooks/usePositions', () => ({ usePositions: () => ({ data: [] }) }))

// Dialogs this page opens but these tests do not exercise.
vi.mock('@/components/payroll/CreatePayrollPeriodDialog', () => ({ CreatePayrollPeriodDialog: () => null }))
vi.mock('@/components/payroll/AdjustPayrollRecordDialog', () => ({ AdjustPayrollRecordDialog: () => null }))
vi.mock('@/components/payroll/RejectPayrollDialog', () => ({ RejectPayrollDialog: () => null }))
vi.mock('@/components/payroll/PayrollDetailsSheet', () => ({ PayrollDetailsSheet: () => null }))

const { default: PayrollPage } = await import('@/pages/payroll/PayrollPage')

function show(periodStatus: Status, recordStatuses: Status[], role = 'hr_manager') {
  state.periodStatus = periodStatus
  state.recordStatuses = recordStatuses
  state.role = role
  return render(<PayrollPage />)
}

afterEach(() => {
  cleanup()
  releaseMutate.mockReset()
})

describe('while employees are being approved', () => {
  it('shows the HR Manager how far approval has got', () => {
    // The production state: approving one employee is not approving the run.
    show('pending_approval', PRODUCTION_STATUSES)
    expect(screen.getByText(/1 of 8 employees approved/)).toBeTruthy()
    expect(screen.getByText('7 awaiting your decision')).toBeTruthy()
  })

  it('tells the HR Manager that Finance is waiting on approval and release', () => {
    show('pending_approval', PRODUCTION_STATUSES)
    expect(
      screen.getByText(/Finance receives this payroll only after every employee is approved and you release it/)
    ).toBeTruthy()
  })

  it('tells HR Staff the same thing, from their side', () => {
    show('pending_approval', PRODUCTION_STATUSES, 'hr_staff')
    expect(screen.getByText(/1 of 8 employees approved/)).toBeTruthy()
    expect(
      screen.getByText(/Finance receives the payroll once every employee is approved and the HR Manager releases it/)
    ).toBeTruthy()
  })

  it('offers no release while anyone is still pending', () => {
    show('pending_approval', PRODUCTION_STATUSES)
    expect(screen.queryByRole('button', { name: /Release Payslips/ })).toBeNull()
  })
})

describe('once every employee is approved', () => {
  const allApproved: Status[] = Array<Status>(8).fill('approved')

  it('says that releasing is what sends the payroll to Finance', () => {
    show('approved', allApproved)
    expect(screen.getByText(/hands the payroll to Finance for payment/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Release Payslips/ })).toBeTruthy()
  })

  it('says so again in the release confirmation, before anything happens', () => {
    show('approved', allApproved)
    fireEvent.click(screen.getByRole('button', { name: /Release Payslips/ }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText(/hands the payroll to Finance for payment/)).toBeTruthy()
    expect(releaseMutate).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Release Payroll' }))
    expect(releaseMutate).toHaveBeenCalledWith({ periodId: PERIOD })
  })

  it('does not offer HR Staff the release', () => {
    show('approved', allApproved, 'hr_staff')
    expect(screen.queryByRole('button', { name: /Release Payslips/ })).toBeNull()
    expect(screen.getByText('Approved — waiting for HR Manager to release')).toBeTruthy()
  })
})

describe('after release', () => {
  it('says Finance has the payroll', () => {
    show('released', Array<Status>(8).fill('released'))
    expect(screen.getByText(/Finance has the payroll to disburse/)).toBeTruthy()
  })
})
