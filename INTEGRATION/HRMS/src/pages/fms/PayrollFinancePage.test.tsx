import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { PayrollFinanceBatch } from '@/lib/payrollFinance'

/**
 * Payroll Finance, as the Accountant sees it.
 *
 * Two things this page has to be honest about. A payroll appears here only
 * once HR RELEASES it -- the word on HR's own button -- so the empty state must
 * say that, not a word HR never sees. And a failed load is not "nothing to
 * pay": showing zeros and an empty-state under an error is how a permissions or
 * network failure would pass for a quiet payroll week.
 */

const state: {
  batches: PayrollFinanceBatch[] | undefined
  isLoading: boolean
  isError: boolean
  error: unknown
} = { batches: [], isLoading: false, isError: false, error: null }

/** The production payroll, as the rolled-back dry run of its real release
 *  showed Finance would receive it. */
const released: PayrollFinanceBatch = {
  id: 'b1',
  batch_no: 'PY-2026-0001',
  source_payroll_period_id: 'de11348f-c676-43ed-ae38-2d0d8f680f48',
  period_start: '2026-09-01',
  period_end: '2026-10-31',
  pay_date: '2026-10-01',
  frequency: 'monthly',
  employee_count: 8,
  gross_total: 355000,
  deductions_total: 210457.92,
  net_total: 144542.08,
  amount_paid: 0,
  balance_due: 144542.08,
  pending_disbursement: 0,
  available_to_prepare: 144542.08,
  settlement_state: 'awaiting_disbursement',
  source_finalized_at: '2026-10-03T12:30:00Z',
  created_at: '2026-10-03T12:30:00Z',
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'acct', role: 'accountant' } }),
}))

vi.mock('@/hooks/usePayrollFinance', () => ({
  usePayrollFinanceBatches: () => ({
    data: state.batches,
    isLoading: state.isLoading,
    isError: state.isError,
    error: state.error,
  }),
  usePayrollFinanceItems: () => ({ data: [] }),
  usePayrollDisbursements: () => ({ data: [] }),
  useCreateDisbursement: () => ({ mutate: vi.fn(), isPending: false }),
  useTransitionDisbursement: () => ({ mutate: vi.fn(), isPending: false }),
}))

const { default: PayrollFinancePage } = await import('@/pages/fms/PayrollFinancePage')

/** A card's label and its figure share a parent. The cards render before the
 *  table, so the first match is the card even when a row shows the same words. */
const kpi = (label: string) => screen.getAllByText(label)[0].parentElement!.textContent ?? ''

afterEach(() => {
  cleanup()
  state.batches = []
  state.isLoading = false
  state.isError = false
  state.error = null
})

describe('a released payroll', () => {
  it('arrives with exactly the figures HR released', () => {
    state.batches = [released]
    render(<PayrollFinancePage />)

    const row = screen.getByText('PY-2026-0001').closest('tr')!
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent?.trim())
    // Payroll, Employees, Gross, Deductions, Net payable, Balance, Status.
    expect(cells[0]).toContain('PY-2026-0001')
    expect(cells.slice(1)).toEqual([
      '8',
      '₱355,000.00',
      '−₱210,457.92',
      '₱144,542.08',
      '₱144,542.08',
      'Awaiting disbursement',
    ])
  })

  it('counts it in the cards from the same rows as the table', () => {
    state.batches = [released]
    render(<PayrollFinancePage />)

    expect(kpi('Awaiting disbursement')).toContain('1')
    expect(kpi('Employees to pay')).toContain('8')
    expect(kpi('Net still owing')).toContain('₱144,542.08')
  })
})

describe('nothing released yet', () => {
  it('says so, in the word HR uses for the step', () => {
    render(<PayrollFinancePage />)
    expect(screen.getByText('No payroll to disburse')).toBeTruthy()
    expect(screen.getByText(/as soon as HR releases a payroll period/)).toBeTruthy()
    expect(screen.queryByText(/finalizes/)).toBeNull()
  })
})

describe('a load that failed', () => {
  it('reports the failure instead of an empty payroll', () => {
    state.batches = undefined
    state.isError = true
    state.error = new Error('permission denied for function get_payroll_finance_batches')
    render(<PayrollFinancePage />)

    expect(screen.getByText(/permission denied/)).toBeTruthy()
    // The two things that would read as "there is genuinely nothing to pay":
    // the empty state, and three cards of zeros.
    expect(screen.queryByText('No payroll to disburse')).toBeNull()
    for (const label of ['Awaiting disbursement', 'Employees to pay', 'Net still owing']) {
      expect(kpi(label), label).toContain('Unavailable')
    }
    expect(kpi('Net still owing')).not.toContain('₱0.00')
  })
})
