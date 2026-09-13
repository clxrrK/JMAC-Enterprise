import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Branch } from '@/hooks/useBranches'
import type { DashboardSummary, PaymentTotal, TopProduct } from '@/lib/posDashboard'
import type { InventoryRow } from '@/lib/posInventory'
import type { PosAssignment } from '@/lib/portals'
import type { TransactionRow } from '@/lib/posTransactions'

/**
 * The POS Manager's dashboard.
 *
 * The claims worth pinning: it asks only about branches this account actually
 * manages, it shows the three money figures under names that reconcile, and it
 * shows no cost. The last one is guaranteed in the database -- none of the RPCs
 * declares a cost column -- and this proves the page did not invent one.
 */

const CAVITE = 'cavite'
const MAIN = 'main'

const branches: Branch[] = [
  { id: CAVITE, name: 'Cavite Branch', address: null, phone: null, latitude: null, longitude: null, is_active: true, show_on_landing: false, image_path: null, display_order: 0, created_at: '', updated_at: '' },
  { id: MAIN, name: 'Main Office', address: null, phone: null, latitude: null, longitude: null, is_active: true, show_on_landing: false, image_path: null, display_order: 0, created_at: '', updated_at: '' },
]

/** The branch stock the RPC would return, keyed by branch, so a test can prove
 * the card shows the selected branch's shelf and not somebody else's. */
const shelves: Record<string, InventoryRow[]> = {}

const state: {
  assignments: PosAssignment[]
  summary: DashboardSummary | undefined
  payments: PaymentTotal[]
  top: TopProduct[]
  recent: TransactionRow[]
  /** What the stock query is doing. Only an answered query -- one holding rows
   * -- permits the card to make a claim about the shelf. 'stale' is the state
   * React Query reports when a background refetch fails over data already in
   * hand: an error, with the last good rows still there. */
  stock: 'success' | 'loading' | 'error' | 'stale'
  /** Branches still arriving, so no branch is resolved yet and the stock query
   * has not been allowed to run. */
  branchesLoading: boolean
} = {
  assignments: [],
  summary: undefined,
  payments: [],
  top: [],
  recent: [],
  stock: 'success',
  branchesLoading: false,
}

/** Every branch id the page asked any query about. */
const asked: string[] = []

function stockRow(name: string, quantity: number, over: Partial<InventoryRow> = {}): InventoryRow {
  return {
    product_id: `p-${name}`,
    product_name: name,
    category_name: 'Drinks',
    quantity_on_hand: quantity,
    // Left at the schema default on purpose: this is the column whose
    // `not null default 0` made the old low-stock condition unsatisfiable.
    low_stock_threshold: 0,
    is_low_stock: false,
    is_available: true,
    product_status: 'active',
    ...over,
  }
}

function summary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    business_date: '2026-08-25',
    sales_collected: 330,
    product_sales: 300,
    fees_collected: 30,
    transaction_count: 3,
    items_sold: 7,
    average_sale: 110,
    low_stock_count: 2,
    out_of_stock_count: 1,
    ...overrides,
  }
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u1', role: 'employee' },
    posAccess: {
      hasAccess: state.assignments.length > 0,
      branchIds: state.assignments.map((a) => a.branchId),
      assignments: state.assignments,
    },
  }),
}))

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () =>
    state.branchesLoading
      ? { data: undefined, isLoading: true }
      : { data: branches, isLoading: false },
}))

vi.mock('@/hooks/usePosDashboard', () => ({
  useBusinessDay: () => ({
    data: {
      business_date: '2026-08-25',
      day_start: '2026-08-24T16:00:00+00:00',
      day_end: '2026-08-25T16:00:00+00:00',
    },
  }),
  useDashboardSummary: (branchId?: string) => {
    if (branchId) asked.push(branchId)
    return { data: state.summary, isLoading: false, isError: false, error: null }
  },
  useDashboardPaymentTotals: (branchId?: string) => {
    if (branchId) asked.push(branchId)
    return { data: state.payments, isLoading: false, isError: false, error: null }
  },
  useDashboardTopProducts: (branchId?: string) => {
    if (branchId) asked.push(branchId)
    return { data: state.top, isLoading: false, isError: false, error: null }
  },
  useDashboardRecentSales: (branchId?: string) => {
    if (branchId) asked.push(branchId)
    return { data: state.recent, isLoading: false, isError: false, error: null }
  },
}))

/**
 * The same hook the Products and Inventory pages use, mocked at its own
 * boundary. Scoped by argument exactly as `get_branch_inventory` is: ask about
 * Cavite and you get Cavite's shelf, and a branch with no entry here returns
 * nothing rather than falling back to some other branch's stock.
 *
 * `enabled: !!branchId` is reproduced too, because that disabled state is the
 * one the card must not read as good news: not loading, not failed, no data.
 */
vi.mock('@/hooks/usePosInventory', () => ({
  useBranchInventory: (branchId?: string) => {
    if (branchId) asked.push(branchId)
    if (!branchId) return { data: undefined, isSuccess: false, isError: false, isLoading: false }
    if (state.stock === 'loading') {
      return { data: undefined, isSuccess: false, isError: false, isLoading: true }
    }
    if (state.stock === 'error') {
      return { data: undefined, isSuccess: false, isError: true, isLoading: false }
    }
    if (state.stock === 'stale') {
      // React Query keeps `data` when a refetch fails, and reports the error
      // alongside it rather than instead of it.
      return { data: shelves[branchId] ?? [], isSuccess: false, isError: true, isLoading: false }
    }
    return {
      data: shelves[branchId] ?? [],
      isSuccess: true,
      isError: false,
      isLoading: false,
    }
  },
}))

const { default: PosDashboardPage } = await import('@/pages/pos/PosDashboardPage')

function show(url = '/pos/dashboard') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <PosDashboardPage />
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  state.assignments = []
  state.summary = undefined
  state.payments = []
  state.top = []
  state.recent = []
  state.stock = 'success'
  state.branchesLoading = false
  for (const key of Object.keys(shelves)) delete shelves[key]
  asked.length = 0
})

describe('what a manager sees', () => {
  it('names the three money figures so they reconcile', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    show()

    expect(screen.getByText('Sales collected today')).toBeTruthy()
    expect(screen.getByText('Product sales')).toBeTruthy()
    expect(screen.getByText('Customer fees')).toBeTruthy()
    expect(screen.getByText('₱330.00')).toBeTruthy()
    expect(screen.getByText('₱300.00')).toBeTruthy()
    expect(screen.getByText('₱30.00')).toBeTruthy()
  })

  // The relationship the three figures have is now shown by where they sit --
  // the components inside the takings card -- rather than explained in a
  // paragraph underneath it.
  it('shows the parts inside the total they add up to', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    show()

    const takings = screen.getByText('Sales collected today').closest('div[class*="p-5"]')!
    expect(takings.textContent).toContain('₱330.00')
    expect(takings.textContent).toContain('Product sales')
    expect(takings.textContent).toContain('₱300.00')
    expect(takings.textContent).toContain('Customer fees')
    expect(takings.textContent).toContain('₱30.00')
  })

  it('says so loudly when the three do not add up', () => {
    // The lib could always check this and the comment said the page should say
    // so out loud. It never did. A mismatch is not a rounding curiosity -- it
    // means the RPC and these labels have drifted apart.
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary({ sales_collected: 999 })
    show()

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/do not add up/i)
  })

  it('stays quiet while they do add up', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    show()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('never calls anything "Net Sales"', () => {
    // The standalone put `subtotal` on a card reading "Today's Net Sales" and
    // never showed what the customer actually paid.
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    const { container } = show()
    expect(container.textContent ?? '').not.toMatch(/net sales/i)
  })

  it('counts units sold, taking the number the RPC gives it', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary({ items_sold: 7, transaction_count: 3 })
    show()
    expect(screen.getByText(/7 items sold/)).toBeTruthy()
  })

  it('shows no cost, COGS, margin or profit', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    state.top = [
      { product_id: 'p1', product_name: 'Cola 1.5L', quantity_sold: 4, sales_amount: 400 },
    ]
    state.payments = [{ payment_method: 'cash', transaction_count: 3, amount_collected: 330 }]
    const { container } = show()
    const text = (container.textContent ?? '').replace(
      /cost and profit are not part of this view/i,
      ''
    )
    expect(text).not.toMatch(/\bcost\b/i)
    expect(text).not.toMatch(/COGS/i)
    expect(text).not.toMatch(/margin/i)
    expect(text).not.toMatch(/profit/i)
  })

  it('is not the old placeholder', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    const { container } = show()
    expect(container.textContent ?? '').not.toMatch(/portal is set up/i)
  })

  it('labels the day the server chose, not the device"s idea of today', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    show()
    expect(screen.getByText(/Trading today —/)).toBeTruthy()
  })

  it('says an empty day is empty rather than showing a broken panel', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary({ transaction_count: 0, sales_collected: 0 })
    show()
    expect(screen.getByText('Nothing has sold yet today.')).toBeTruthy()
    expect(screen.getByText('No sales have been rung up yet today.')).toBeTruthy()
  })

  it('draws each payment method as a share of the day', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    state.payments = [
      { payment_method: 'cash', transaction_count: 3, amount_collected: 300 },
      { payment_method: 'gcash', transaction_count: 1, amount_collected: 100 },
    ]
    show()

    // 300 of 400 is 75%, 100 of 400 is 25% -- announced, not just drawn, so a
    // screen reader gets the proportion too.
    expect(screen.getByLabelText("75% of today's takings")).toBeTruthy()
    expect(screen.getByLabelText("25% of today's takings")).toBeTruthy()
  })

  it('lists the biggest payment method first', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    state.payments = [
      { payment_method: 'gcash', transaction_count: 1, amount_collected: 50 },
      { payment_method: 'cash', transaction_count: 9, amount_collected: 900 },
    ]
    const { container } = show()
    const text = container.textContent ?? ''
    expect(text.indexOf('Cash')).toBeLessThan(text.indexOf('GCash'))
  })

  it('does not present a manual e-wallet reference as settled money', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    state.payments = [{ payment_method: 'gcash', transaction_count: 2, amount_collected: 200 }]
    show()
    expect(screen.getByText(/not a confirmation that the payment settled/)).toBeTruthy()
  })

  /**
   * The recent-sales list names a sale the way its receipt does.
   *
   * It used to print the first eight characters of the sale's uuid, so a
   * manager reading this panel saw BA2F5555 for the sale whose printed receipt
   * said OR-2026-0009 -- two unrelated-looking references for one sale, with
   * nothing on either screen connecting them.
   */
  it('identifies a recent sale by its receipt number', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    state.recent = [
      {
        sale_id: 'ba2f5555-1111-2222-3333-444444444444',
        receipt_number: 'OR-2026-0009',
        created_at: '2026-09-04T02:30:00Z',
        status: 'completed',
        branch_id: CAVITE,
        branch_name: 'Cavite Branch',
        cashier_name: 'Ana Cruz',
        item_count: 2,
        subtotal: 100,
        fees_total: 0,
        total_amount: 100,
        payment_method: 'cash',
        payment_reference: null,
        amount_tendered: 200,
        change_given: 100,
        total_count: 1,
      },
    ]
    const { container } = show()

    expect(screen.getByText('OR-2026-0009')).toBeTruthy()
    // The old value, named so it cannot creep back unnoticed.
    expect(container.textContent).not.toContain('BA2F5555')
    expect(container.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    )
  })
})

/**
 * What needs attention.
 *
 * The reported bug: Cavite held five Coca-Cola and zero Sting and the card
 * said "Everything on the shelf is in stock." The card was reading the
 * dashboard summary's two counts, whose low-stock condition was
 *
 *     quantity_on_hand > 0 AND quantity_on_hand <= low_stock_threshold
 *
 * against a column declared `not null default 0`. For a product nobody had
 * configured that is `q > 0 AND q <= 0`, which no row can satisfy. The same
 * lateral also filtered on `bp.is_available`, so stopping a line on the till
 * hid its empty shelf.
 *
 * The card now reads `get_branch_inventory` -- the stock the Products and
 * Inventory pages read -- and flags everything at or under five.
 */
describe('what needs attention', () => {
  const manageCavite = () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
  }

  it('shows the reported Cavite shelf as products rather than as counts', () => {
    manageCavite()
    shelves[CAVITE] = [
      stockRow('Coca-Cola 5.6', 5),
      stockRow('Sting 250ml', 0),
      stockRow('ZZ PayMongo Verification', 19),
    ]
    show()

    expect(screen.getByText('Coca-Cola 5.6')).toBeTruthy()
    expect(screen.getByText('Low stock — 5 remaining')).toBeTruthy()
    expect(screen.getByText('Sting 250ml')).toBeTruthy()
    expect(screen.getByText('Out of stock')).toBeTruthy()
    // Nineteen is not a shortage, and the card must not pad itself with one.
    expect(screen.queryByText('ZZ PayMongo Verification')).toBeNull()
    expect(screen.queryByText('Everything on the shelf is in stock.')).toBeNull()
  })

  it('flags nothing above five and everything at or below it', () => {
    manageCavite()
    shelves[CAVITE] = [
      stockRow('Six', 6),
      stockRow('Five', 5),
      stockRow('One', 1),
      stockRow('Zero', 0),
    ]
    show()

    expect(screen.getByText('Zero')).toBeTruthy()
    expect(screen.getByText('One')).toBeTruthy()
    expect(screen.getByText('Five')).toBeTruthy()
    expect(screen.queryByText('Six')).toBeNull()
  })

  it('puts the empty shelves first', () => {
    manageCavite()
    shelves[CAVITE] = [stockRow('Four', 4), stockRow('Empty', 0), stockRow('Two', 2)]
    const { container } = show()
    const text = container.textContent ?? ''

    expect(text.indexOf('Empty')).toBeLessThan(text.indexOf('Two'))
    expect(text.indexOf('Two')).toBeLessThan(text.indexOf('Four'))
  })

  it('still flags a product the manager stopped on the till', () => {
    // Whether the till is offering something says nothing about whether there
    // is any of it. The old query filtered these out entirely.
    manageCavite()
    shelves[CAVITE] = [stockRow('Paused Line', 0, { is_available: false })]
    show()

    expect(screen.getByText('Paused Line')).toBeTruthy()
    expect(screen.getByText('Out of stock')).toBeTruthy()
  })

  it('does not nag about a product that has been retired', () => {
    // Archiving leaves the branch rows behind at whatever they held, and the
    // till will never offer the product again. A permanent "Out of stock" for
    // something nobody can restock is noise in a card that exists to be acted
    // on -- and it would crowd out the shortages that can be.
    manageCavite()
    shelves[CAVITE] = [
      stockRow('Retired Line', 0, { product_status: 'archived' }),
      stockRow('Sting 250ml', 0),
    ]
    show()

    expect(screen.getByText('Sting 250ml')).toBeTruthy()
    expect(screen.queryByText('Retired Line')).toBeNull()
    expect(screen.getByText('1 product')).toBeTruthy()
  })

  it('sends the manager to that branch"s stock page', () => {
    manageCavite()
    shelves[CAVITE] = [stockRow('Sting 250ml', 0)]
    show()

    const row = screen.getByText('Sting 250ml').closest('a')!
    expect(row.getAttribute('href')).toBe(`/pos/stock?branch=${CAVITE}`)
  })

  it('does not leak another branch"s stock into the card', () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'manager' },
    ]
    state.summary = summary()
    shelves[CAVITE] = [stockRow('Cavite Cola', 0)]
    shelves[MAIN] = [stockRow('Main Office Water', 0)]
    show(`/pos/dashboard?branch=${MAIN}`)

    expect(screen.getByText('Main Office Water')).toBeTruthy()
    expect(screen.queryByText('Cavite Cola')).toBeNull()
  })

  it('follows a stock change rather than holding the first answer', () => {
    // The card renders whatever the shared pos-branch-inventory query holds, so
    // a sale, a receipt or an adjustment invalidating that key moves the card.
    manageCavite()
    shelves[CAVITE] = [stockRow('Coca-Cola 5.6', 5)]
    show()
    expect(screen.getByText('Low stock — 5 remaining')).toBeTruthy()

    cleanup()
    shelves[CAVITE] = [stockRow('Coca-Cola 5.6', 0)]
    show()
    expect(screen.getByText('Out of stock')).toBeTruthy()
    expect(screen.queryByText('Low stock — 5 remaining')).toBeNull()
  })

  it('lists every qualifying product rather than a top few', () => {
    // A cap here would be a silent omission of exactly what the card exists to
    // report -- the twelfth product is as out of stock as the first.
    manageCavite()
    shelves[CAVITE] = Array.from({ length: 12 }, (_, i) => stockRow(`Short ${i}`, i % 6))
    show()

    for (let i = 0; i < 12; i += 1) {
      expect(screen.getByText(`Short ${i}`), `product ${i}`).toBeTruthy()
    }
    expect(screen.getByText('12 products')).toBeTruthy()
  })

  it('says the shelf is stocked only when the query said so', () => {
    manageCavite()
    shelves[CAVITE] = [stockRow('Plenty', 40)]
    show()
    expect(screen.getByText('Everything on the shelf is in stock.')).toBeTruthy()
  })

  it('never calls an unfinished request good news', () => {
    manageCavite()
    // Rows the server would eventually return, so "nothing rendered" cannot be
    // mistaken for "there was nothing to render".
    shelves[CAVITE] = [stockRow('Sting 250ml', 0)]
    state.stock = 'loading'
    const { container } = show()

    expect(screen.queryByText('Everything on the shelf is in stock.')).toBeNull()
    expect(screen.queryByText('Sting 250ml')).toBeNull()
    // Every other panel's mock reports isLoading false, so these are the stock
    // card's own placeholders.
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
  })

  it('does not congratulate a branch that has no stock to be in stock', () => {
    // An empty result is not an all-clear. It is a branch carrying nothing --
    // and it is also what get_branch_inventory returns to a caller it will not
    // answer, since its manager check is a WHERE clause and not an error. A
    // permissions denial must not read as good news about the shelf.
    manageCavite()
    shelves[CAVITE] = []
    show()

    expect(screen.getByText('No stock is being tracked for this branch yet.')).toBeTruthy()
    expect(screen.queryByText('Everything on the shelf is in stock.')).toBeNull()
  })

  it('says the stock could not be loaded rather than that it is fine', () => {
    // A failed request carries no information about the shelf, and "everything
    // is in stock" is a positive claim. The dashboard's other cards can fail
    // quietly; this one cannot fail into a reassurance.
    manageCavite()
    state.stock = 'error'
    show()

    expect(screen.getByText('Stock levels could not be loaded. Refresh to try again.')).toBeTruthy()
    expect(screen.queryByText('Everything on the shelf is in stock.')).toBeNull()
  })

  it('keeps the shortages it already knows when a refresh fails', () => {
    // Discarding real alerts for an error message loses the shortage; showing
    // them without a word passes stale figures off as current. Both, then.
    manageCavite()
    shelves[CAVITE] = [stockRow('Sting 250ml', 0)]
    state.stock = 'stale'
    show()

    expect(screen.getByText('Sting 250ml')).toBeTruthy()
    expect(screen.getByText('These levels could not be refreshed just now.')).toBeTruthy()
    expect(screen.queryByText('Everything on the shelf is in stock.')).toBeNull()
  })

  it('says nothing about the shelf before a branch is even resolved', () => {
    // The query is disabled until there is a branch, and a disabled query is
    // neither loading nor failed -- the state that would slip past any check
    // written as "not loading and not an error".
    manageCavite()
    state.branchesLoading = true
    const { container } = show()

    expect(screen.queryByText('Everything on the shelf is in stock.')).toBeNull()
    expect(screen.queryByText('No stock is being tracked for this branch yet.')).toBeNull()
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
    expect(asked).not.toContain('')
  })
})

describe('branch scoping', () => {
  it('offers no picker when there is only one branch to manage', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    show()
    expect(screen.queryByRole('combobox', { name: 'Branch' })).toBeNull()
  })

  it('offers only managed branches, never one they merely cashier at', () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'cashier' },
    ]
    state.summary = summary()
    show()

    // One managed branch means no picker at all -- and the branch shown is the
    // managed one, not whichever assignment came first.
    expect(screen.queryByRole('combobox', { name: 'Branch' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Cavite Branch' })).toBeTruthy()
  })

  it('never asks about a branch it only cashiers at', () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'cashier' },
    ]
    state.summary = summary()
    show()

    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((id) => id === CAVITE)).toBe(true)
    expect(asked).not.toContain(MAIN)
  })

  it('lets someone managing two branches choose, listing both', () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'manager' },
    ]
    state.summary = summary()
    show()
    const picker = screen.getByRole('combobox', { name: 'Branch' })
    // useBranches orders by name, so the first is a deterministic choice.
    expect(picker.textContent).toContain('Cavite Branch')
  })

  it('honours a branch named in the URL when the account manages it', () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'manager' },
    ]
    state.summary = summary()
    show(`/pos/dashboard?branch=${MAIN}`)
    expect(screen.getByRole('heading', { name: 'Main Office' })).toBeTruthy()
  })

  it('ignores a branch named in the URL that the account does not manage', () => {
    // A hand-edited query string is not a grant. The database would refuse it
    // too; this stops the page from pretending otherwise.
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    show(`/pos/dashboard?branch=${MAIN}`)

    expect(screen.getByRole('heading', { name: 'Cavite Branch' })).toBeTruthy()
    expect(asked.every((id) => id === CAVITE)).toBe(true)
  })
})

describe('someone who manages nothing', () => {
  it('is told so instead of shown a page of zeroes', () => {
    state.assignments = [{ branchId: CAVITE, role: 'cashier' }]
    show()
    expect(screen.getByText(/You do not manage a branch/)).toBeTruthy()
  })
})
