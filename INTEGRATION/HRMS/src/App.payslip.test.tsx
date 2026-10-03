import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { policiesOn, type Policy } from '@/test/policies'
import { hiddenInPrint, printRules, removedInPrint } from '@/test/printRules'

/**
 * Opening a payslip, through the real route table.
 *
 * "View Payslip" in My Workspace sent everyone to /dashboard/payroll/:id/payslip,
 * which is HR's address for a payslip. The shell is chosen from the address --
 * only /dashboard/my-* is My Workspace -- so a cashier reading their own payslip
 * was put inside Human Resources with HR's modules down the side, and an
 * Accountant, whose role that route did not list, was turned away altogether.
 *
 * These render App itself -- its routes, guards, layout and sidebar -- with the
 * browser history swapped for an in-memory one, so a test can open an address
 * the way a refresh or a pasted link does, and follow the clicks a person
 * makes. What is stood in for is the data layer, which applies production's
 * RLS rule for payroll records -- and for a payslip's lines, the rule the
 * migrations that ship actually grant -- and the pages these tests only arrive
 * at.
 */

const harness = vi.hoisted(() => ({
  /** Where the app opens. */
  start: '/',
  /** Where it has got to. */
  path: '',
  profile: null as Record<string, unknown> | null,
  pos: {
    hasAccess: false,
    branchIds: [] as string[],
    assignments: [] as { branchId: string; role: string }[],
  },
  /** Every query the app made, with the filters it asked for. */
  queries: [] as { table: string; filters: Record<string, unknown> }[],
  clients: [] as { clear(): void }[],
  /** Whether the migrations that ship let an employee read the lines of their
   *  own released payroll. Set from supabase/migrations, below. */
  employeesReadOwnLines: false,
}))

type Row = Record<string, unknown> & { id: string; employee_id: string; status: string }
type Line = { id: string; payroll_record_id: string; item_type: string; label: string; amount: number; created_at: string }

const GROSS = 40000
const AT = '2026-10-03T12:30:00Z'
const toCentavos = (amount: number) => Math.round(amount * 100) / 100

function payrollRecord(
  id: string,
  employeeId: string,
  [first, last]: [string, string],
  net: number,
  status = 'released'
): Row {
  const at = AT
  return {
    id,
    employee_id: employeeId,
    status,
    currency: 'PHP',
    basic_salary: GROSS,
    gross_salary: GROSS,
    total_deductions: toCentavos(GROSS - net),
    net_salary: net,
    days_present: 22,
    absent_days: 0,
    late_minutes: 0,
    overtime_hours: 0,
    created_at: at,
    payroll_periods: {
      period_start: '2026-09-01',
      period_end: '2026-10-31',
      pay_date: '2026-10-01',
      frequency: 'monthly',
    },
    employees: {
      id: employeeId,
      employee_number: `EMP-${id}`,
      first_name: first,
      last_name: last,
      departments: { name: 'Operations' },
      positions: { title: 'Staff' },
    },
    payslips:
      status === 'released'
        ? [{ id: `ps-${id}`, payroll_record_id: id, payslip_number: `PS-${id}`, released_at: at, created_at: at }]
        : [],
  }
}

/** A payslip's deductions, the way payroll generation writes them: the three
 *  statutory contributions, and absences for the rest of the total. */
function deductionLines(record: Row): Line[] {
  const statutory: [string, number][] = [
    ['SSS Contribution', 1125],
    ['PhilHealth Contribution', 562.5],
    ['Pag-IBIG Contribution', 200],
  ]
  const absences = toCentavos(Number(record.total_deductions) - statutory.reduce((sum, [, amount]) => sum + amount, 0))
  return [...statutory, ['Absences', absences] as [string, number]].map(([label, amount], i) => ({
    id: `${record.id}-line-${i}`,
    payroll_record_id: record.id,
    item_type: 'deduction',
    label,
    amount,
    created_at: AT,
  }))
}

const RECORDS: Row[] = [
  payrollRecord('rec-cashier', 'e-cashier', ['Casey', 'Cashier'], 18567.05),
  // Approved but not released: nobody sees it in My Workspace yet.
  payrollRecord('rec-cashier-next', 'e-cashier', ['Casey', 'Cashier'], 18000, 'approved'),
  payrollRecord('rec-employee', 'e-employee', ['Eli', 'Employee'], 16481.82),
  payrollRecord('rec-hrm', 'e-hrm', ['Harper', 'Manager'], 30000),
  payrollRecord('rec-hrs', 'e-hrs', ['Hayden', 'Staff'], 25000),
  payrollRecord('rec-acct', 'e-acct', ['Avery', 'Accountant'], 28000),
  // Somebody else's, with a name and a figure that appear nowhere else.
  payrollRecord('rec-colleague', 'e-colleague', ['Colleague', 'Bravo'], 31234.56),
]

const LINES: Line[] = RECORDS.flatMap(deductionLines)

/** The policies payroll_line_items is left with once every migration has run. */
const MIGRATIONS = resolve(process.cwd(), 'supabase/migrations')
const lineItemPolicies = policiesOn(
  'payroll_line_items',
  readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), 'utf8') }))
)

/** The rule an employee's read of their payslip's lines needs: an active
 *  employee, a payroll record that is theirs, and released. */
const grantsOwnReleasedLines = (policy: Policy) =>
  policy.command === 'select' &&
  /\bis_active_employee\(\)/.test(policy.definition) &&
  /\bemployee_id\s*=\s*(public\.)?my_employee_id\(\)/.test(policy.definition) &&
  /\bstatus\s*=\s*'released'/.test(policy.definition)

harness.employeesReadOwnLines = [...lineItemPolicies.values()].some(grantsOwnReleasedLines)

interface Person {
  profile: Record<string, unknown>
  pos: typeof harness.pos
}

function person(id: string, role: string, employeeId: string, fullName: string, posRole?: string): Person {
  return {
    profile: {
      id,
      role,
      employee_id: employeeId,
      full_name: fullName,
      email: `${id}@example.test`,
      status: 'active',
      activated_at: '2026-01-01T00:00:00Z',
    },
    pos: posRole
      ? { hasAccess: true, branchIds: ['b1'], assignments: [{ branchId: 'b1', role: posRole }] }
      : { hasAccess: false, branchIds: [], assignments: [] },
  }
}

/** Everyone here has an employee record -- My Workspace is about employment,
 *  whatever else the account does. */
const PEOPLE = {
  cashier: person('u-cashier', 'employee', 'e-cashier', 'Casey Cashier', 'cashier'),
  employee: person('u-employee', 'employee', 'e-employee', 'Eli Employee'),
  hrManager: person('u-hrm', 'hr_manager', 'e-hrm', 'Harper Manager'),
  hrStaff: person('u-hrs', 'hr_staff', 'e-hrs', 'Hayden Staff'),
  accountant: person('u-acct', 'accountant', 'e-acct', 'Avery Accountant'),
}

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  function WhereAmI() {
    harness.path = actual.useLocation().pathname
    return null
  }
  return {
    ...actual,
    // App owns its router. Swapping the browser one for an in-memory one that
    // starts where the test says is the whole of the difference.
    BrowserRouter: ({ children }: { children: ReactNode }) => (
      <actual.MemoryRouter initialEntries={[harness.start]}>
        <WhereAmI />
        {children}
      </actual.MemoryRouter>
    ),
  }
})

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  // App builds its one QueryClient at import, and every test renders that App.
  // Kept so its cache can be emptied between tests: a record refused to one
  // person must not be served from cache to the next.
  class QueryClient extends actual.QueryClient {
    constructor(...args: ConstructorParameters<typeof actual.QueryClient>) {
      super(...args)
      harness.clients.push(this)
    }
  }
  return { ...actual, QueryClient }
})

vi.mock('@/contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    session: harness.profile ? { user: { id: harness.profile.id } } : null,
    profile: harness.profile,
    posAccess: harness.pos,
    initializing: false,
    sessionExpired: false,
    signOut: async () => {},
    refreshProfile: async () => {},
  }),
}))

interface FakeQuery {
  select(columns?: string): FakeQuery
  eq(column: string, value: unknown): FakeQuery
  /** The one list read here (My Payroll's) ends in order(), so that is what
   *  returns the rows. */
  order(): Promise<{ data: unknown; error: null }>
  maybeSingle(): Promise<{ data: unknown; error: null }>
  single(): Promise<{ data: unknown; error: null }>
}

vi.mock('@/lib/supabase', () => {
  const HR = ['admin', 'hr_manager', 'hr_staff']
  function from(table: string): FakeQuery {
    let columns = ''
    const filters: Record<string, unknown> = {}
    const rows = () => {
      harness.queries.push({ table, filters: { ...filters } })
      if (table !== 'payroll_records') return []
      const me = harness.profile ?? {}
      const hr = HR.includes(String(me.role))
      // Production's RLS on payroll_records: HR reads every record
      // (payroll_records_staff_select); anyone else, only their own released
      // ones (payroll_records_self_select).
      const visible = hr ? RECORDS : RECORDS.filter((r) => r.employee_id === me.employee_id && r.status === 'released')
      return visible
        .filter((r) => Object.entries(filters).every(([column, value]) => r[column] === value))
        .map((r) => {
          // An embedded resource is there only when the query asks for it, and
          // it holds only the lines RLS lets this person read: HR all of them
          // (payroll_line_items_staff_select), anyone else what the migrations
          // grant -- see employeesReadOwnLines.
          if (!columns.includes('payroll_line_items')) return r
          const readable =
            hr || (harness.employeesReadOwnLines && r.employee_id === me.employee_id && r.status === 'released')
          return { ...r, payroll_line_items: readable ? LINES.filter((line) => line.payroll_record_id === r.id) : [] }
        })
    }
    const query: FakeQuery = {
      select: (wanted = '') => {
        columns = wanted
        return query
      },
      eq: (column, value) => {
        filters[column] = value
        return query
      },
      order: async () => ({ data: rows(), error: null }),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
    }
    return query
  }
  const channel: { on(): unknown; subscribe(): unknown } = { on: () => channel, subscribe: () => channel }
  return {
    supabase: {
      from,
      rpc: async () => ({ data: null, error: null }),
      channel: () => channel,
      removeChannel: async () => {},
    },
  }
})

vi.mock('@/hooks/useEmployeePortal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useEmployeePortal')>()),
  useMyEmployeeRecord: () => ({ data: null }),
  useMyPortalRealtimeAlerts: () => {},
}))
vi.mock('@/hooks/useSystemSettings', () => ({
  useSystemSettings: () => ({ data: { company_name: 'JMAC Enterprise' } }),
}))
vi.mock('@/components/layout/CalendarWidget', () => ({ CalendarWidget: () => null }))

// Pages these tests only arrive at. What each one does is tested where it
// lives; here, arriving is the whole point.
vi.mock('@/pages/payroll/PayrollPage', () => ({ default: () => <h2>HR Payroll page</h2> }))
vi.mock('@/pages/employee-portal/EmployeeDashboard', () => ({ default: () => <h2>Employee dashboard page</h2> }))
vi.mock('@/pages/fms/FinanceHomePage', () => ({ default: () => <h2>Finance home page</h2> }))
vi.mock('@/pages/public/HomePage', () => ({ default: () => <h1>Public home page</h1> }))

const { default: App } = await import('@/App')

function open(address: string, who: Person) {
  harness.start = address
  harness.profile = who.profile
  harness.pos = who.pos
  return render(<App />)
}

const sidebar = () => screen.getByRole('complementary')
const payslipFor = (recordId: string) => screen.findByText(`Payslip — PS-${recordId}`)

/** The self-service shell, and nothing of Human Resources. */
function expectMyWorkspace() {
  const side = within(sidebar())
  expect(side.getByText('My Workspace')).toBeTruthy()
  expect(side.getByRole('link', { name: 'My Payroll' })).toBeTruthy()
  expect(side.queryByText('Human Resources')).toBeNull()
  for (const name of ['Employees', 'Interview Management', 'Deployment', 'Reports']) {
    expect(side.queryByRole('link', { name }), name).toBeNull()
  }
}

afterEach(() => {
  cleanup()
  for (const client of harness.clients) client.clear()
  harness.queries = []
})

describe('View Payslip, in My Workspace', () => {
  it('opens the payslip at a My Workspace address, inside My Workspace', async () => {
    open('/dashboard/my-payroll', PEOPLE.cashier)
    fireEvent.click(await screen.findByRole('button', { name: /View Payslip/ }))

    expect(await payslipFor('rec-cashier')).toBeTruthy()
    expect(harness.path).toBe('/dashboard/my-payroll/rec-cashier/payslip')
    expectMyWorkspace()
  })

  // The shell follows where the payslip was opened, not the job the person
  // does. Each of these people also works in Human Resources or Finance.
  it.each<[string, Person, string]>([
    ['an HR Manager', PEOPLE.hrManager, 'rec-hrm'],
    ['HR Staff', PEOPLE.hrStaff, 'rec-hrs'],
    // Turned away before: the old route listed the HR roles and 'employee'.
    ['an Accountant', PEOPLE.accountant, 'rec-acct'],
  ])('does the same for %s opening their own', async (_who, who, recordId) => {
    open('/dashboard/my-payroll', who)
    fireEvent.click(await screen.findByRole('button', { name: /View Payslip/ }))

    expect(await payslipFor(recordId)).toBeTruthy()
    expect(harness.path).toBe(`/dashboard/my-payroll/${recordId}/payslip`)
    expectMyWorkspace()
  })
})

describe('the My Workspace payslip address', () => {
  it('opens in My Workspace on its own, as after a refresh or from a pasted link', async () => {
    open('/dashboard/my-payroll/rec-cashier/payslip', PEOPLE.cashier)
    expect(await payslipFor('rec-cashier')).toBeTruthy()
    expectMyWorkspace()
  })

  it('goes Back to My Payroll', async () => {
    open('/dashboard/my-payroll/rec-cashier/payslip', PEOPLE.cashier)
    await payslipFor('rec-cashier')
    const back = screen.getByRole('link', { name: 'Back' })
    expect(back.getAttribute('href')).toBe('/dashboard/my-payroll')

    fireEvent.click(back)
    expect(await screen.findByRole('heading', { name: 'My Payroll' })).toBeTruthy()
    expect(harness.path).toBe('/dashboard/my-payroll')
    expectMyWorkspace()
  })

  it('goes Back to My Payroll for an HR Manager too, not to HR Payroll', async () => {
    open('/dashboard/my-payroll/rec-hrm/payslip', PEOPLE.hrManager)
    await payslipFor('rec-hrm')
    expect(screen.getByRole('link', { name: 'Back' }).getAttribute('href')).toBe('/dashboard/my-payroll')
  })
})

describe("somebody else's payslip", () => {
  it('is not shown to an employee who puts its id in a My Workspace address', async () => {
    open('/dashboard/my-payroll/rec-colleague/payslip', PEOPLE.cashier)
    expect(await screen.findByText('Payslip not available')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Colleague|Bravo|31,234\.56/)
    expectMyWorkspace()
  })

  it('is not shown in My Workspace even to an HR Manager, who may read it in HR', async () => {
    // RLS lets HR read every record, which HR Payroll needs. My Workspace is
    // about the person signed in, so its query asks for theirs and nothing else.
    open('/dashboard/my-payroll/rec-colleague/payslip', PEOPLE.hrManager)
    expect(await screen.findByText('Payslip not available')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Colleague|Bravo|31,234\.56/)
    expect(harness.queries).toContainEqual({
      table: 'payroll_records',
      filters: { id: 'rec-colleague', employee_id: 'e-hrm', status: 'released' },
    })
  })

  it("cannot be reached through HR's payslip address by an employee", async () => {
    // Refused like any other HR address, rather than shown inside Human Resources.
    open('/dashboard/payroll/rec-colleague/payslip', PEOPLE.employee)
    expect(await screen.findByText('Employee dashboard page')).toBeTruthy()
    expect(harness.path).toBe('/dashboard/my-dashboard')
    expect(document.body.textContent).not.toMatch(/Payslip|Colleague|31,234\.56/)
    expect(screen.queryByText('Human Resources')).toBeNull()
  })
})

describe('a payslip opened from HR Payroll', () => {
  it('stays in Human Resources, and Back returns to HR Payroll', async () => {
    open('/dashboard/payroll/rec-colleague/payslip', PEOPLE.hrManager)
    expect(await payslipFor('rec-colleague')).toBeTruthy()
    const side = within(sidebar())
    expect(side.getByText('Human Resources')).toBeTruthy()
    expect(side.queryByText('My Workspace')).toBeNull()

    const back = screen.getByRole('link', { name: 'Back' })
    expect(back.getAttribute('href')).toBe('/dashboard/payroll')
    fireEvent.click(back)
    expect(await screen.findByText('HR Payroll page')).toBeTruthy()
    expect(harness.path).toBe('/dashboard/payroll')
    expect(within(sidebar()).getByText('Human Resources')).toBeTruthy()
  })
})

/**
 * The breakdown under Total Deductions.
 *
 * Production had no policy letting an employee read payroll_line_items, so
 * every payslip outside HR said "No deductions" directly above a nonzero Total
 * Deductions: the total comes from payroll_records, the lines from a table the
 * employee could not read. The fake data layer above grants employees their
 * lines only if a policy in supabase/migrations does, so these fail if that
 * policy is ever dropped or loosened out of shape -- or if the payslip stops
 * asking for its lines.
 */
describe("the deductions on an employee's own payslip", () => {
  /** "-₱19,545.45" → 1954545 */
  const centavos = (shown: string) => Math.round(Number(shown.replace(/[^0-9.]/g, '')) * 100)

  it('are readable by an active employee for their own released payroll, per the migrations', () => {
    const own = lineItemPolicies.get('payroll_line_items_self_select')
    expect(own, 'no payroll_line_items_self_select once every migration has run').toBeDefined()
    expect(grantsOwnReleasedLines(own!), own!.definition).toBe(true)
  })

  it.each<[string, Person, string]>([
    ['a cashier', PEOPLE.cashier, 'rec-cashier'],
    ['an Accountant', PEOPLE.accountant, 'rec-acct'],
  ])('are listed for %s, and add up to Total Deductions', async (_who, who, recordId) => {
    open(`/dashboard/my-payroll/${recordId}/payslip`, who)
    const totalLabel = await screen.findByText('Total Deductions')
    const shownTotal = totalLabel.nextElementSibling!.textContent!
    const section = totalLabel.closest('section')!
    const lines = [...section.querySelectorAll(':scope > div')]
      .filter((row) => !row.contains(totalLabel))
      .map((row) => ({ label: row.firstElementChild!.textContent, amount: centavos(row.lastElementChild!.textContent!) }))

    expect(centavos(shownTotal)).toBeGreaterThan(0)
    expect(
      lines.length,
      `Total Deductions is ${shownTotal} but no deduction line reached the payslip -- ` +
        "the employee's read of their own released lines is blocked (payroll_line_items_self_select)"
    ).toBeGreaterThan(0)
    expect(within(section).queryByText('No deductions')).toBeNull()
    expect(lines.map((line) => line.label)).toEqual([
      'SSS Contribution',
      'PhilHealth Contribution',
      'Pag-IBIG Contribution',
      'Absences',
    ])
    // The breakdown explains the total; it does not change it.
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(centavos(shownTotal))
  })
})

describe('printing a payslip from My Workspace', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
  const rules = printRules(css)

  it('prints the whole payslip and nothing of the app around it', async () => {
    open('/dashboard/my-payroll/rec-cashier/payslip', PEOPLE.cashier)
    const article = (await payslipFor('rec-cashier')).closest('article')!

    // Every part of the payslip reaches paper. The blank-print bug was a print
    // rule that hid the whole of a document.
    for (const el of [article, ...article.querySelectorAll('*')]) {
      const what = `<${el.tagName.toLowerCase()}> "${el.textContent?.slice(0, 40)}"`
      expect(removedInPrint(rules, el), `${what} is removed`).toBe(false)
      expect(hiddenInPrint(rules, el), `${what} is hidden`).toBe(false)
    }
    for (const figure of ['Casey Cashier', 'EMP-rec-cashier', '₱18,567.05']) {
      expect(article.textContent, figure).toContain(figure)
    }

    // Nothing removed on the way up, and every flex box a block in print --
    // flex nested in flex cut printed lines in half at the page edges.
    for (let el: Element | null = article.parentElement; el && el !== document.body; el = el.parentElement) {
      expect(removedInPrint(rules, el)).toBe(false)
      expect(hiddenInPrint(rules, el)).toBe(false)
      if (/(^|\s)flex(\s|$)/.test(el.className)) expect(el.className, el.className).toContain('print:block')
    }

    // My Workspace's sidebar and the top bar stay off the page, and so do the
    // Back and Print buttons.
    expect(sidebar().className).toContain('print:hidden')
    // The payslip has a <header> of its own; the top bar is the one outside it.
    const topBar = [...document.querySelectorAll('header')].find((el) => !article.contains(el))!
    expect(topBar.className).toContain('print:hidden')
    const bar = screen.getByRole('button', { name: /Print \/ Save as PDF/ }).parentElement!
    expect(bar.className).toContain('print:hidden')
    expect(article.contains(bar)).toBe(false)
  })
})
