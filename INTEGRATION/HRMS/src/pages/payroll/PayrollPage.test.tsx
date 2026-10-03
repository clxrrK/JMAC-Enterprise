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

/** Production's figures for the period. */
const PRODUCTION_MONEY = { gross: 355000, deductions: 210457.92, net: 144542.08 }

const state: {
  role: string
  periodStatus: Status
  recordStatuses: Status[]
  money: { gross: number; deductions: number; net: number }
} = { role: 'hr_manager', periodStatus: 'pending_approval', recordStatuses: [], money: PRODUCTION_MONEY }

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
      grossPayroll: state.money.gross,
      totalDeductions: state.money.deductions,
      totalNetPayroll: state.money.net,
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
  state.money = PRODUCTION_MONEY
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

/**
 * The six figures above the table.
 *
 * They overlapped. Six columns were switched on by the WINDOW's width (xl,
 * 1280px), but the cards sit beside a 16rem sidebar on a page capped at 72rem,
 * so each card got 150-182px, and ₱355,000.00 -- 126px of bold display type
 * beside a 40px icon -- ran into the next card. jsdom does no layout, so these
 * pin the structure that prevents it; the widths were measured in a browser.
 */
describe('the summary cards', () => {
  const LABELS = ['Payroll Period', 'Employees Included', 'Gross Payroll', 'Total Deductions', 'Total Net Payroll', 'Payslips Released']
  const grid = () => screen.getByText('Gross Payroll').closest('.grid') as HTMLElement

  it("shows all six, each figure in its own card, at sizes far past today's", () => {
    state.money = { gross: 12_500_000, deductions: 7_410_490.16, net: 5_089_509.84 }
    show('released', Array<Status>(8).fill('released'))
    const cards = [...grid().children]
    const figures = ['Sep 1, 2026 – Oct 31, 2026', '8', '₱12,500,000.00', '₱7,410,490.16', '₱5,089,509.84', '8']
    expect(cards).toHaveLength(6)
    // Its own label and figure, and nothing of another card's.
    cards.forEach((card, i) => expect(card.textContent).toBe(`${LABELS[i]}${figures[i]}`))
  })

  it("counts its columns from the width it is given, not the window's", () => {
    show('released', Array<Status>(8).fill('released'))
    const classes = grid().className.split(/\s+/)
    expect(classes.filter((c) => /^(sm|md|lg|xl|2xl):grid-cols-/.test(c))).toEqual([])
    expect(grid().parentElement!.className.split(/\s+/)).toContain('@container')
    const steps = classes.flatMap((c) => {
      const step = /^@min-\[([\d.]+)rem\]:grid-cols-(\d+)$/.exec(c)
      return step ? [{ at: Number(step[1]), columns: Number(step[2]) }] : []
    })
    expect(steps.map((step) => step.columns)).toEqual([2, 3, 6])
    // Each step is that many 16rem cards and the 0.75rem gaps between them;
    // 16rem is what a card needs to hold ₱999,999,999.99 beside its icon.
    for (const { at, columns } of steps) expect(at).toBe(columns * 16 + (columns - 1) * 0.75)
  })

  it('keeps an oversized figure in its card, wrapping rather than running into the next', () => {
    show('released', Array<Status>(8).fill('released'))
    const figure = screen.getByText('₱355,000.00')
    expect(figure.className).toContain('[overflow-wrap:anywhere]')
    // A flex child will not shrink below its content without this.
    expect(figure.parentElement!.className.split(/\s+/)).toContain('min-w-0')
  })

  it('breaks the period between its two dates, never inside one', () => {
    show('released', Array<Status>(8).fill('released'))
    const dates = [...grid().children[0].querySelectorAll('span.whitespace-nowrap')].map((span) => span.textContent)
    expect(dates).toEqual(['Sep 1, 2026 –', 'Oct 31, 2026'])
  })
})
