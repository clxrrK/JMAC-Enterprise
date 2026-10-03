import { describe, expect, it } from 'vitest'
import {
  BUDGET_NEUTRAL_NOTE,
  SNAPSHOT_NOTE,
  canPrepareDisbursement,
  disbursementActionsFor,
  formatPayPeriod,
  roomForDisbursement,
  type PayrollDisbursement,
} from '@/lib/payrollFinance'

/**
 * Payroll, from Finance's side of the boundary.
 *
 * The claims worth pinning here are about what Finance does NOT do: it does
 * not calculate, it does not charge a budget, and it does not let the person
 * who prepared a disbursement approve it.
 */

function disbursement(over: Partial<PayrollDisbursement> = {}): PayrollDisbursement {
  return {
    id: 'd1',
    disbursement_no: 'PD-2026-0001',
    batch_id: 'b1',
    batch_no: 'PY-2026-0001',
    treasury_account_id: 'acc1',
    account_name: 'Main Bank Account',
    amount: 60000,
    method: 'bank_transfer',
    payment_date: null,
    reference: null,
    notes: null,
    status: 'for_approval',
    prepared_by: 'accountant-1',
    prepared_by_name: 'Ana Cruz',
    approved_by_name: null,
    approved_at: null,
    paid_by_name: null,
    paid_at: null,
    decision_reason: null,
    created_at: '2026-09-05T02:00:00Z',
    ...over,
  }
}

describe('what the page says about the boundary', () => {
  it('says the figures are HR’s and cannot be changed here', () => {
    expect(SNAPSHOT_NOTE).toMatch(/snapshot of what HR released/i)
    expect(SNAPSHOT_NOTE).toMatch(/Finance does not calculate payroll/i)
    expect(SNAPSHOT_NOTE).toMatch(/corrected in HR|made in HR/i)
  })

  // Not silence: HR payroll names no budget, so there is nothing authoritative
  // to consume, and inventing one would be fabricating accounting.
  it('says why payroll touches no budget', () => {
    expect(BUDGET_NEUTRAL_NOTE).toMatch(/not charged to a procurement budget/i)
    expect(BUDGET_NEUTRAL_NOTE).toMatch(/records no.*budget/i)
    expect(BUDGET_NEUTRAL_NOTE).toMatch(/treasury only/i)
  })
})

describe('the pay period, on the Manila clock', () => {
  it('reads as the period a payslip names', () => {
    const shown = formatPayPeriod({ period_start: '2026-08-01', period_end: '2026-08-15' })
    expect(shown).toMatch(/Aug 1, 2026/)
    expect(shown).toMatch(/Aug 15, 2026/)
  })

  // A date-only value must not be dragged across a timezone on its way to the
  // screen: 1 August is 1 August wherever the reader is.
  it('does not shift the first of a month backwards', () => {
    expect(formatPayPeriod({ period_start: '2026-01-01', period_end: '2026-01-15' })).toMatch(
      /Jan 1, 2026/
    )
  })
})

describe('whether a disbursement may be prepared', () => {
  it('offers it to the Accountant while something is available', () => {
    expect(canPrepareDisbursement({ available_to_prepare: 40000 }, 'accountant')).toBe(true)
  })

  it('withdraws it once the batch is fully covered', () => {
    expect(canPrepareDisbursement({ available_to_prepare: 0 }, 'accountant')).toBe(false)
  })

  it('never offers it to the Finance Manager, who approves instead', () => {
    expect(canPrepareDisbursement({ available_to_prepare: 40000 }, 'finance_manager')).toBe(false)
  })
})

describe('what one disbursement may still claim', () => {
  it('excludes itself, so a returned one can come back', () => {
    const d = disbursement({ amount: 60000, status: 'returned' })
    expect(roomForDisbursement(d, [d], 100000)).toBe(100000)
  })

  it('counts live siblings against it', () => {
    const d = disbursement({ id: 'd1', amount: 50000, status: 'returned' })
    const sibling = disbursement({ id: 'd2', amount: 60000, status: 'approved' })
    expect(roomForDisbursement(d, [d, sibling], 100000)).toBe(40000)
  })

  it('ignores a paid sibling, which is counted as paid instead', () => {
    const d = disbursement({ id: 'd1', amount: 40000, status: 'draft' })
    const done = disbursement({ id: 'd2', amount: 60000, status: 'paid' })
    expect(roomForDisbursement(d, [d, done], 40000)).toBe(40000)
  })
})

describe('maker and checker on a disbursement', () => {
  it('lets the Finance Manager decide one somebody else prepared', () => {
    expect(disbursementActionsFor(disbursement(), 'finance_manager', 'm1').canDecide).toBe(true)
  })

  // Identity, not role: somebody promoted overnight still cannot approve what
  // they prepared yesterday.
  it('refuses approval to the person who prepared it', () => {
    expect(disbursementActionsFor(disbursement(), 'finance_manager', 'accountant-1').canDecide).toBe(
      false
    )
  })

  it('gives the Finance Manager no way to record the payment', () => {
    expect(
      disbursementActionsFor(disbursement({ status: 'approved' }), 'finance_manager', 'm1').canRecord
    ).toBe(false)
  })

  it('offers Record only after approval', () => {
    expect(
      disbursementActionsFor(disbursement({ status: 'for_approval' }), 'accountant', 'a1').canRecord
    ).toBe(false)
    expect(
      disbursementActionsFor(disbursement({ status: 'approved' }), 'accountant', 'a1').canRecord
    ).toBe(true)
  })

  it('offers nothing once it is paid', () => {
    const can = disbursementActionsFor(disbursement({ status: 'paid' }), 'accountant', 'a1')
    expect(can.canSubmit || can.canDecide || can.canRecord).toBe(false)
  })
})
