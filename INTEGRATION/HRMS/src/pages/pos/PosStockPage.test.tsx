import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { UserRole } from '@/lib/enums'
import type { Branch } from '@/hooks/useBranches'
import type { Movement } from '@/hooks/usePosInventory'
import type { InventoryRow } from '@/lib/posInventory'

/**
 * Branch stock, as POS staff see it.
 *
 * Two claims worth pinning: nothing on this page can show cost, because the
 * RPCs behind it declare no cost column; and the only write it offers is the
 * low-stock level, because receiving and adjusting are Administrator-only in
 * this phase.
 */

const BRANCH_A = 'b1'
const BRANCH_B = 'b2'

const branches: Branch[] = [
  { id: BRANCH_A, name: 'Main Office', address: null, phone: null, latitude: null, longitude: null, is_active: true, show_on_landing: false, image_path: null, display_order: 0, created_at: '', updated_at: '' },
  { id: BRANCH_B, name: 'Cavite Branch', address: null, phone: null, latitude: null, longitude: null, is_active: true, show_on_landing: false, image_path: null, display_order: 0, created_at: '', updated_at: '' },
]

const state: {
  role: UserRole
  posRole: 'manager' | 'cashier'
  branchIds: string[]
  rows: InventoryRow[]
  movements: Movement[]
} = { role: 'employee', posRole: 'manager', branchIds: [BRANCH_A], rows: [], movements: [] }

const setThreshold = vi.fn()

function row(overrides: Partial<InventoryRow> = {}): InventoryRow {
  return {
    product_id: 'p1',
    product_name: 'Cola 1.5L',
    category_name: 'Drinks',
    quantity_on_hand: 12,
    low_stock_threshold: 5,
    is_low_stock: false,
    is_available: true,
    product_status: 'active',
    ...overrides,
  }
}

const setAvailability = vi.fn()

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u1', role: state.role },
    posAccess: {
      hasAccess: true,
      branchIds: state.branchIds,
      // (branch, role) pairs: the offered switch belongs only to a branch this
      // account actually manages.
      assignments: state.branchIds.map((branchId) => ({ branchId, role: state.posRole })),
    },
  }),
}))

vi.mock('@/hooks/usePosCatalogue', () => ({
  useSetBranchAvailability: () => ({ mutate: setAvailability, isPending: false }),
}))

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: branches, isLoading: false }),
}))

/** Which branch the stock read was actually asked about. */
const askedFor: (string | undefined)[] = []

vi.mock('@/hooks/usePosInventory', () => ({
  useBranchInventory: (branchId: string | undefined) => {
    askedFor.push(branchId)
    return { data: state.rows, isLoading: false }
  },
  useBranchMovements: (_b: string | undefined, enabled: boolean) => ({
    data: enabled ? state.movements : [],
    isLoading: false,
  }),
  useSetLowStockThreshold: () => ({ mutate: setThreshold, isPending: false }),
}))

const { default: PosStockPage } = await import('@/pages/pos/PosStockPage')

function renderPage(url = '/pos/stock') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <PosStockPage />
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  state.role = 'employee'
  state.posRole = 'manager'
  state.branchIds = [BRANCH_A]
  state.rows = []
  state.movements = []
  setThreshold.mockReset()
  setAvailability.mockReset()
  askedFor.length = 0
})

/**
 * Arriving here from a stock alert.
 *
 * The dashboard's "Needs attention" card names a product at a named branch and
 * links here. Landing on a different branch's shelf than the one that raised
 * the alert makes the card's own figures look wrong.
 */
describe('the branch a link asks for', () => {
  it('opens the branch the alert came from', () => {
    state.branchIds = [BRANCH_A, BRANCH_B]
    renderPage(`/pos/stock?branch=${BRANCH_B}`)
    expect(askedFor).toContain(BRANCH_B)
    expect(askedFor).not.toContain(BRANCH_A)
  })

  it('falls back to the first branch when no branch is named', () => {
    state.branchIds = [BRANCH_A, BRANCH_B]
    renderPage()
    expect(askedFor).toContain(BRANCH_A)
  })

  it('ignores a branch the account does not hold', () => {
    // A hand-edited query string is not a grant. The RPC would refuse it as
    // well; this stops the page from asking in the first place.
    state.branchIds = [BRANCH_A]
    renderPage(`/pos/stock?branch=${BRANCH_B}`)
    expect(askedFor).not.toContain(BRANCH_B)
    expect(askedFor).toContain(BRANCH_A)
  })
})

describe('what a POS manager sees', () => {
  it('shows quantity and the low-stock level', () => {
    state.rows = [row()]
    renderPage()

    expect(screen.getByText('Cola 1.5L')).toBeTruthy()
    expect(screen.getByText('12')).toBeTruthy()
    expect((screen.getByLabelText('Low-stock level for Cola 1.5L') as HTMLInputElement).value).toBe('5')
  })

  it('shows no cost of any kind', () => {
    state.rows = [row()]
    state.movements = [
      {
        id: 'm1',
        product_id: 'p1',
        product_name: 'Cola 1.5L',
        movement_type: 'receipt',
        quantity_change: 12,
        stock_before: 0,
        stock_after: 12,
        source_type: 'manual_receiving',
        notes: null,
        actor_name: 'Administrator',
        created_at: '2026-08-25T00:00:00Z',
      },
    ]
    const { container } = renderPage()
    fireEvent.click(screen.getByRole('button', { name: /History/ }))

    const text = container.textContent ?? ''
    expect(text).not.toMatch(/cost/i)
    expect(text).not.toMatch(/margin/i)
    expect(text).not.toMatch(/COGS/i)
    expect(text).not.toMatch(/₱/)
  })

  it('says receiving and adjusting belong to an Administrator', () => {
    state.rows = [row()]
    renderPage()
    expect(screen.getByText(/done by an Administrator/)).toBeTruthy()
  })

  it('offers no way to receive or adjust', () => {
    state.rows = [row()]
    renderPage()
    expect(screen.queryByRole('button', { name: /Receive/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Adjust/ })).toBeNull()
  })

  it('saves a changed low-stock level', () => {
    state.rows = [row({ low_stock_threshold: 5 })]
    renderPage()

    const field = screen.getByLabelText('Low-stock level for Cola 1.5L')
    fireEvent.change(field, { target: { value: '20' } })
    fireEvent.blur(field)

    expect(setThreshold).toHaveBeenCalledWith({ branchId: BRANCH_A, productId: 'p1', threshold: 20 })
  })

  it('shows whether a product is offered, but does not switch it here', () => {
    // The switch moved to Products. This screen answers "how many"; Products
    // answers "what do we sell". Two screens owning one control is the
    // ambiguity that put the switch on this page in the first place.
    state.rows = [row({ is_available: true })]
    renderPage()

    // The column header is also "Offered", so look in the row, not the head.
    const inRow = screen.getAllByText('Offered').filter((el) => el.closest('td'))
    expect(inRow).toHaveLength(1)
    expect(screen.queryByRole('switch', { name: 'Offer Cola 1.5L at this branch' })).toBeNull()
  })

  it('marks a stopped product', () => {
    state.rows = [row({ is_available: false })]
    renderPage()
    expect(screen.getByText('Stopped')).toBeTruthy()
  })
})

describe('what a cashier sees', () => {
  it('is pointed at the POS screen rather than shown an empty table', () => {
    // get_branch_inventory is manager-gated, so a cashier receives no rows at
    // all. Explaining that is better than an empty grid that looks broken.
    // (A cashier has no nav item for this page either -- this is the
    // typed-the-URL case.)
    state.rows = []
    // A cashier, not a manager: that is what makes this the "no stock view"
    // case rather than "this branch is empty".
    state.posRole = 'cashier'
    renderPage()

    expect(screen.getByText(/shown on the POS screen/)).toBeTruthy()
    expect(screen.queryByText('Cola 1.5L')).toBeNull()
  })
})

describe('branch scoping', () => {
  it('offers no picker for a single assignment', () => {
    state.rows = [row()]
    renderPage()
    expect(screen.queryByLabelText('Branch')).toBeNull()
  })

  it('gives an administrator every active branch', () => {
    state.role = 'admin'
    state.branchIds = []
    state.rows = [row()]
    renderPage()
    expect(screen.getByLabelText('Branch')).toBeTruthy()
  })

  it('says so when the account is assigned to no branch', () => {
    state.branchIds = []
    renderPage()
    expect(screen.getByText(/not assigned to a branch/)).toBeTruthy()
  })
})

describe('an authorized branch with nothing in it', () => {
  it('says the branch is empty, not that the account has no access', () => {
    // The hosted bug. A manager of a brand-new branch was told "There is no
    // stock view for this account", which reads as a permission problem. Zero
    // rows and no authority are different conditions and now say so.
    state.rows = []
    state.posRole = 'manager'
    renderPage()

    expect(screen.getByText('No products are stocked at this branch yet.')).toBeTruthy()
    expect(screen.queryByText(/no stock view for this account/)).toBeNull()
  })

  it('offers the way out rather than leaving a dead end', () => {
    state.rows = []
    state.posRole = 'manager'
    renderPage()

    // Two of them, and both correct: the shared Inventory header always offers
    // one, and the empty state repeats it where the eye already is.
    const links = screen.getAllByRole('link', { name: 'New request' })
    expect(links.length).toBeGreaterThanOrEqual(1)
    for (const link of links) {
      expect(link.getAttribute('href')).toContain('/pos/requests')
    }
  })

  it('still tells a cashier this page is not theirs', () => {
    state.rows = []
    state.posRole = 'cashier'
    renderPage()

    expect(screen.getByText(/no stock view for this account/)).toBeTruthy()
    expect(screen.queryByText('No products are stocked at this branch yet.')).toBeNull()
  })
})
