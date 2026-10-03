import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Branch } from '@/hooks/useBranches'
import type { CatalogueRow } from '@/hooks/usePosCatalogue'
import type { Receipt } from '@/hooks/usePosTill'
import type { TransactionRow } from '@/lib/posTransactions'
import { hiddenInPrint, printRules, removedInPrint, rulesFor } from '@/test/printRules'

/**
 * One receipt, two doors.
 *
 * The till used to render a hand-written summary of the sale it had just taken
 * while transaction history rendered SaleReceipt, so the same sale read
 * differently depending on which screen you were standing at -- the till showed
 * no receipt number, no branch address, no unit prices, no status, and offered
 * no way to print.
 *
 * The strongest thing to assert is not that either screen looks right, but that
 * they are the SAME: the test below drives a real cash sale through the till,
 * captures the printed receipt, then opens the same sale from history and
 * compares them character for character. Nothing short of that catches the two
 * drifting apart again.
 */

const BRANCH = 'b1'
/** The internal key, which never reaches a customer. */
const SALE = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
/** The receipt as the customer holds it — persisted on the sale, not derived
 *  from the uuid above. Deliberately unrelated to it, so a test cannot pass by
 *  accident if the old slice-the-uuid behaviour came back. */
const RECEIPT_NO = 'OR-2026-0042'

const branches: Branch[] = [
  { id: BRANCH, name: 'Cavite Branch', address: null, phone: null, latitude: null, longitude: null, is_active: true, show_on_landing: false, image_path: null, display_order: 0, created_at: '', updated_at: '' },
]

const catalogue: CatalogueRow[] = [
  {
    product_id: 'p1', name: 'Coca-Cola 1.5L', category_id: 'c1', category_name: 'Drinks',
    selling_price: 70, image_path: null, available_quantity: 10, is_low_stock: false,
  },
]

/**
 * The sale as the database returns it.
 *
 * Both entry points get this from the same builder -- `checkout_pos_sale` and
 * `get_sale_detail` each return `pos_sale_receipt(sale_id)` -- so one fixture
 * standing in for both is the shape production actually has, not a convenience.
 */
function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    sale_id: SALE,
    receipt_number: RECEIPT_NO,
    created_at: '2026-09-04T10:15:44.000Z',
    status: 'completed',
    company_name: 'JMAC Enterprise',
    branch_name: 'Cavite Branch',
    branch_address: '123 Aguinaldo Highway, Imus',
    branch_phone: '0917 000 0000',
    cashier_name: 'Liza Fernandez',
    items: [
      { product_name: 'Coca-Cola 1.5L', category_name: 'Drinks', quantity: 2, unit_price: 70, line_total: 140 },
    ],
    subtotal: 140,
    fees: [{ name: 'Service Charge', type: 'percent', value: 5, amount: 7 }],
    fees_total: 7,
    total_amount: 147,
    payment_method: 'cash',
    payment_reference: null,
    amount_tendered: 200,
    change_given: 53,
    ...overrides,
  }
}

const state: { receipt: Receipt } = { receipt: receipt() }
const checkoutMutate = vi.fn()

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u1', role: 'employee' },
    posAccess: { hasAccess: true, branchIds: [BRANCH], assignments: [{ branchId: BRANCH, role: 'cashier' }] },
  }),
}))
vi.mock('@/hooks/useBranches', () => ({ useBranches: () => ({ data: branches, isLoading: false }) }))
vi.mock('@/hooks/usePosCatalogue', () => ({
  usePosCatalogue: () => ({ data: catalogue, isLoading: false }),
  useProductImageUrls: () => ({ data: {}, isLoading: false }),
}))
vi.mock('@/hooks/usePosTill', () => ({
  useBranchFees: () => ({ data: [{ id: 'f1', name: 'Service Charge', type: 'percent', value: 5, enabled: true }] }),
  useCheckout: () => ({
    // The sale the SERVER made, handed straight back -- which is why the
    // receipt does not depend on the cart that produced it.
    mutate: (args: unknown, opts?: { onSuccess?: (r: Receipt) => void }) => {
      checkoutMutate(args)
      opts?.onSuccess?.(state.receipt)
    },
    isPending: false, isError: false, error: null,
  }),
}))
vi.mock('@/hooks/usePosPayment', () => ({
  useCreateOnlineCheckout: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  usePaymentAttempt: () => ({ data: null, isFetching: false, refetch: vi.fn() }),
  useCancelPaymentAttempt: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useRefreshAfterOnlineSale: () => () => {},
}))

const listRow = (): TransactionRow => ({
  sale_id: SALE, receipt_number: state.receipt.receipt_number,
  created_at: state.receipt.created_at, status: 'completed',
  branch_id: BRANCH, branch_name: 'Cavite Branch', cashier_name: 'Liza Fernandez',
  item_count: 2, subtotal: 140, fees_total: 7, total_amount: 147,
  payment_method: state.receipt.payment_method, payment_reference: state.receipt.payment_reference,
  amount_tendered: state.receipt.amount_tendered, change_given: state.receipt.change_given,
  total_count: 1,
})

vi.mock('@/hooks/usePosTransactions', () => ({
  usePosTransactions: () => ({ data: [listRow()], isLoading: false, isError: false, error: null }),
  useSaleDetail: (saleId: string | null) => ({
    data: saleId ? state.receipt : null,
    isLoading: false, isError: false, error: null,
  }),
}))

const { default: PosTillPage } = await import('@/pages/pos/PosTillPage')
const { PosTransactionsView } = await import('@/components/pos/PosTransactionsView')

/** Ring up a cash sale and land on the receipt. */
function sellForCash(tendered = '200') {
  const view = render(
    <MemoryRouter>
      <PosTillPage />
    </MemoryRouter>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Add Coca-Cola 1.5L' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add Coca-Cola 1.5L' }))
  fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: tendered } })
  fireEvent.click(screen.getByRole('button', { name: /Take payment/ }))
  return view
}

/** Open the same sale the way a cashier would tomorrow. */
function reprintFromHistory() {
  render(
    <MemoryRouter>
      <PosTransactionsView scope="mine" showCashier showBranch emptyMessage="none" />
    </MemoryRouter>
  )
  // The register names the row by its receipt number too, so this locator only
  // resolves if the list is showing the same reference the receipt does.
  fireEvent.click(screen.getByRole('button', { name: `Receipt for ${RECEIPT_NO}` }))
}

const printed = () => document.querySelector('#printable-receipt')?.textContent ?? ''

afterEach(() => {
  cleanup()
  state.receipt = receipt()
  checkoutMutate.mockReset()
})

describe('after taking payment at the till', () => {
  it('puts the receipt in front of the cashier straight away', () => {
    sellForCash()
    expect(screen.getByText('Sale complete')).toBeTruthy()
    expect(printed()).not.toBe('')
  })

  it('offers Print without a trip to Transactions', () => {
    sellForCash()
    expect(screen.getByRole('button', { name: /print/i })).toBeTruthy()
    // The old flow's only route to a printable receipt was the other page.
    expect(screen.queryByRole('link', { name: /transactions/i })).toBeNull()
  })

  it('shows what the server saved, not what the cart held', () => {
    // The cart was two at ₱70 with a 5% fee. The receipt reads the sale, so if
    // the server had priced it differently that is what would appear.
    sellForCash()
    const text = printed()
    expect(text).toContain('Coca-Cola 1.5L')
    expect(text).toContain('₱147.00')
    expect(text).toContain('Liza Fernandez')
    expect(text).toContain('123 Aguinaldo Highway, Imus')
  })

  it('survives the cart being cleared, because it never read it', () => {
    sellForCash()
    // The cart is empty behind the dialog and the receipt is still whole.
    expect(printed()).toContain('Coca-Cola 1.5L')
    expect(screen.getByText(/Tap a product to start a sale/)).toBeTruthy()
  })
})

describe('the same sale, from either door', () => {
  it('renders one identical receipt', () => {
    sellForCash()
    const fromTill = printed()
    cleanup()

    reprintFromHistory()
    const fromHistory = printed()

    expect(fromTill).not.toBe('')
    expect(fromTill).toBe(fromHistory)
  })

  it.each([
    ['receipt number', RECEIPT_NO],
    ['branch', 'Cavite Branch'],
    ['branch address', '123 Aguinaldo Highway, Imus'],
    ['item and quantity', 'Coca-Cola 1.5L'],
    ['unit price', '@ ₱70.00'],
    ['line total', '₱140.00'],
    ['fee', 'Service Charge'],
    ['total', '₱147.00'],
    ['payment method', 'Cash'],
    ['cashier', 'Liza Fernandez'],
    ['status', 'Completed'],
  ])('carries the same %s on both', (_label, expected) => {
    sellForCash()
    expect(printed(), 'till').toContain(expected)
    cleanup()

    reprintFromHistory()
    expect(printed(), 'history').toContain(expected)
  })

  // The receipt reference is the sale's own persisted number. It used to be
  // the first eight characters of the uuid, computed in the browser -- so this
  // asserts both that the real number appears AND that no part of the internal
  // key does.
  it('prints the persisted receipt number and no part of the uuid', () => {
    sellForCash()
    const text = printed()

    expect(text).toContain(RECEIPT_NO)
    expect(text).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    )
    // The old behaviour, named so it cannot creep back unnoticed.
    expect(text).not.toContain(SALE.slice(0, 8).toUpperCase())
  })
})

describe('cash and everything else', () => {
  it('counts the money back on a cash sale', () => {
    sellForCash()
    const text = printed()
    expect(text).toContain('Cash received')
    expect(text).toContain('₱200.00')
    expect(text).toContain('Change')
    expect(text).toContain('₱53.00')
  })

  it('says nothing about cash on a sale that took none', () => {
    // A GCash sale stores no tendered amount. Printing "Cash received ₱0.00 /
    // Change ₱0.00" would describe a cash drawer that was never opened.
    state.receipt = receipt({
      payment_method: 'gcash',
      payment_reference: 'JMAC-POS-9F2A11',
      amount_tendered: null,
      change_given: null,
    })
    reprintFromHistory()

    const text = printed()
    expect(text).toContain('GCash')
    expect(text).toContain('JMAC-POS-9F2A11')
    expect(text).not.toContain('Cash received')
    expect(text).not.toContain('Change')
  })
})

describe('a receipt is read-only', () => {
  it('takes payment once, however the receipt is handled', () => {
    sellForCash()
    expect(checkoutMutate).toHaveBeenCalledTimes(1)

    // Everything a cashier can do to a receipt: print it, then close it.
    fireEvent.click(screen.getByRole('button', { name: /print/i }))
    for (const close of screen.getAllByRole('button', { name: /close/i })) {
      fireEvent.click(close)
    }

    expect(checkoutMutate).toHaveBeenCalledTimes(1)
  })

  it('opening one from history charges nobody', () => {
    reprintFromHistory()
    fireEvent.click(screen.getByRole('button', { name: /print/i }))
    expect(checkoutMutate).not.toHaveBeenCalled()
  })

  it('offers no control that could imply the sale is not yet recorded', () => {
    sellForCash()
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/confirm|finish|record|save sale|submit|retry/i)
    }
  })
})

/**
 * What comes out of the printer.
 *
 * Layout is CSS, which jsdom does not compute, so these assert the two things
 * that decide the outcome and that jsdom CAN see: exactly one print target in
 * the document, with the screen-only controls outside it — plus the stylesheet
 * rule that isolates it, read from disk.
 */
describe('printing', () => {
  const printCss = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    .match(/@media print\s*\{[\s\S]*$/)?.[0] ?? ''

  it('puts exactly one print target in the document', () => {
    sellForCash()
    expect(document.querySelectorAll('#printable-receipt')).toHaveLength(1)
    cleanup()

    reprintFromHistory()
    expect(document.querySelectorAll('#printable-receipt')).toHaveLength(1)
  })

  it('keeps Close and Print outside the printed region', () => {
    sellForCash()
    const target = document.querySelector('#printable-receipt')!
    for (const label of [/print/i, /close/i]) {
      for (const button of screen.getAllByRole('button', { name: label })) {
        expect(target.contains(button), `${button.textContent} is inside the receipt`).toBe(false)
      }
    }
  })

  it('keeps the receipt content inside it', () => {
    sellForCash()
    const target = document.querySelector('#printable-receipt')!
    // The things that must survive onto paper.
    for (const expected of [RECEIPT_NO, 'Cavite Branch', 'Coca-Cola 1.5L', '₱147.00', 'Liza Fernandez']) {
      expect(target.textContent, expected).toContain(expected)
    }
  })

  /**
   * What the print stylesheet selects, applied to the real rendered DOM.
   *
   * The rule this replaced -- `body * { visibility: hidden }`, with the
   * receipt un-hidden beneath it -- was asserted here as correct. It printed
   * every page without a receipt blank (the contract test covers that side),
   * and it positioned the receipt absolutely inside the dialog's scroll box,
   * which collapsed in print to its title row and clipped the receipt to one
   * line. These assert the outcome in terms jsdom can actually check: which
   * elements the real rules take out of the printout, and which they leave.
   */
  const rules = printRules(readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8'))

  for (const [door, open] of [
    ['the till', () => sellForCash()],
    ['history', () => reprintFromHistory()],
  ] as const) {
    it(`prints the receipt and only the receipt, from ${door}`, () => {
      open()
      const receipt = document.querySelector('#printable-receipt')!

      // The receipt and every box around it stay in the printout.
      for (let el: Element | null = receipt; el && el !== document.body; el = el.parentElement) {
        expect(removedInPrint(rules, el), `${el.tagName} around the receipt is removed`).toBe(false)
        expect(hiddenInPrint(rules, el), `${el.tagName} around the receipt is hidden`).toBe(false)
      }
      for (const el of receipt.querySelectorAll('*')) {
        expect(removedInPrint(rules, el)).toBe(false)
      }

      // Everything else in <body> -- the page behind the dialog, the overlay --
      // is out of layout, so it prints nothing and adds no blank pages.
      for (const branch of document.body.children) {
        if (branch.contains(receipt) || branch.tagName === 'SCRIPT') continue
        expect(removedInPrint(rules, branch), `<${branch.tagName.toLowerCase()}> beside the dialog prints`).toBe(true)
      }

      // Inside the dialog, everything but the receipt: title, Close, Print, ×.
      const dialog = receipt.closest('[role="dialog"]')!
      for (const child of dialog.children) {
        if (child === receipt) continue
        expect(removedInPrint(rules, child), `dialog part "${child.textContent}" prints`).toBe(true)
      }
    })
  }

  it('renders the receipt outside the page, so removing the page cannot take it too', () => {
    // The page is removed from print with display: none, which nothing inside
    // could undo. That is only safe because the dialog portals to <body>.
    // `container` is where the till page itself is mounted.
    const { container } = sellForCash()
    const receipt = document.querySelector('#printable-receipt')!
    expect(container.contains(receipt)).toBe(false)
    expect(removedInPrint(rules, container)).toBe(true)
    expect(receipt.closest('[role="dialog"]')?.parentElement?.parentElement).toBe(document.body)
  })

  it('lets the receipt flow on the page instead of clipping it inside the dialog', () => {
    sellForCash()
    const receipt = document.querySelector('#printable-receipt')!
    const dialog = receipt.closest('[role="dialog"]')!
    const onDialog = Object.assign({}, ...rulesFor(rules, dialog).map((rule) => rule.declarations))
    // The dialog's box is a scroll box on screen; in print it must not be one.
    expect(onDialog).toMatchObject({ position: 'static', overflow: 'visible', 'max-height': 'none' })
    // And the receipt is not lifted out of flow into a fixed-height box again.
    const onReceipt = Object.assign({}, ...rulesFor(rules, receipt).map((rule) => rule.declarations))
    expect(onReceipt.position).not.toBe('absolute')
    // Its existing 80mm thermal width, flowing at 100% on narrower paper.
    expect(onReceipt).toMatchObject({ width: '100%', 'max-width': '80mm' })
  })

  it('prints dark on white rather than relying on background colours', () => {
    // Browsers omit backgrounds from print by default, so a receipt that
    // depended on them would come out as pale text on nothing.
    expect(printCss).toMatch(/color:\s*#000/)
    expect(printCss).toMatch(/background:\s*(#fff|transparent)/)
  })

  it('is one receipt, not a screen copy and a print copy', () => {
    // The failure this guards: someone adds ReceiptForPrint alongside the
    // shared one and the two drift, which is the whole defect this work fixed.
    const dialog = readFileSync(
      resolve(process.cwd(), 'src/components/pos/PosReceiptDialog.tsx'),
      'utf8'
    )
    expect(dialog.match(/<SaleReceipt/g) ?? []).toHaveLength(1)
    expect(dialog).not.toMatch(/ReceiptForPrint|PrintableReceipt|ReceiptForScreen/)
  })

  it('is reached the same way from both doors', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})

    sellForCash()
    fireEvent.click(screen.getByRole('button', { name: /print/i }))
    expect(print).toHaveBeenCalledTimes(1)
    cleanup()

    reprintFromHistory()
    fireEvent.click(screen.getByRole('button', { name: /print/i }))
    expect(print).toHaveBeenCalledTimes(2)

    print.mockRestore()
  })
})

describe('the next customer', () => {
  it('leaves the till clear once the receipt is closed', () => {
    sellForCash()
    for (const close of screen.getAllByRole('button', { name: /close/i })) {
      fireEvent.click(close)
    }

    expect(screen.queryByText('Sale complete')).toBeNull()
    expect(screen.getByText(/Tap a product to start a sale/)).toBeTruthy()
    // The cash field is empty, so the next sale does not inherit the last
    // customer's money.
    expect((screen.getByLabelText('Cash received') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('Subtotal (0 items)')).toBeTruthy()
  })

  it('can ring up the next sale immediately', () => {
    sellForCash()
    for (const close of screen.getAllByRole('button', { name: /close/i })) {
      fireEvent.click(close)
    }

    fireEvent.click(screen.getByRole('button', { name: 'Add Coca-Cola 1.5L' }))
    expect(screen.getByText('Subtotal (1 items)')).toBeTruthy()
  })
})
