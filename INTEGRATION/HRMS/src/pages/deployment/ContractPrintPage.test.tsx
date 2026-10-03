import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { hiddenInPrint, pageRule, printRules, removedInPrint, rulesFor } from '@/test/printRules'

/**
 * The employment contract, printed.
 *
 * It printed as five blank pages. The print stylesheet carried a rule written
 * for the POS receipt -- `body * { visibility: hidden }`, with the receipt
 * un-hidden beneath it -- and the rule applied to every printout. The contract
 * has no receipt to un-hide, so every element of it was laid out (Chrome
 * counted the pages) and none was drawn.
 *
 * jsdom does no layout, so what these assert is what the real stylesheet
 * SELECTS on the real rendered page, inside the real dashboard shell. Native
 * print preview still needs a person (see the commit that added this file).
 */

const APP = 'a1'

const application = {
  id: APP,
  reference_code: 'JMAC-2026-0007',
  applicant_first_name: 'Maria',
  applicant_last_name: 'Dela Cruz',
  applicant_email: 'maria@example.test',
  applicant_address: '123 Rizal Street, Imus, Cavite',
  applicant_phone: '0917 000 0000',
  applicants: null,
  job_postings: { positions: { title: 'Store Cashier' }, departments: { name: 'Retail Operations' } },
  job_offers: [
    {
      created_at: '2026-09-20T00:00:00Z',
      start_date: '2026-10-15',
      employment_type: 'regular',
      proposed_salary: 18500,
      currency: 'PHP',
      working_hours: '8:00 AM - 5:00 PM',
      working_days: 'Monday to Saturday',
      additional_compensation: 'Rice allowance.',
      employment_contracts: [
        {
          created_at: '2026-09-21T00:00:00Z',
          start_date: '2026-10-15',
          terms: 'TERMS-TEXT 1. Duties.',
          company_policies: 'POLICIES-TEXT 1. Attendance.',
          additional_notes: 'NOTES-TEXT',
          signer: { full_name: 'Ana Reyes' },
          signed_at: null,
        },
      ],
    },
  ],
}

vi.mock('@/lib/supabase', () => ({ supabase: {} }))

vi.mock('@/hooks/useDeployment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useDeployment')>()),
  useDeploymentApplicationDetail: () => ({ data: application, isLoading: false }),
}))

vi.mock('@/hooks/useSystemSettings', () => ({
  useSystemSettings: () => ({ data: { company_name: 'JMAC Enterprise' } }),
}))

// The shell's sidebar and navbar need a signed-in session. Stand-ins keep the
// real root element and classes, which is all printing looks at.
vi.mock('@/components/layout/Sidebar', () => ({
  Sidebar: () => <aside data-testid="sidebar" className="hidden md:flex print:hidden" />,
}))
vi.mock('@/components/layout/Navbar', () => ({
  Navbar: () => <header data-testid="navbar" className="flex h-16 print:hidden" />,
}))

const { DashboardLayout } = await import('@/components/layout/DashboardLayout')
const { default: ContractPrintPage } = await import('@/pages/deployment/ContractPrintPage')

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
const rules = printRules(css)

function openContract() {
  return render(
    <MemoryRouter initialEntries={[`/dashboard/deployment/${APP}/contract`]}>
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="/dashboard/deployment/:applicationId/contract" element={<ContractPrintPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  )
}

const article = () => screen.getByText('Contract of Employment').closest('article')!
const sectionWith = (text: string) => screen.getByText(new RegExp(text)).closest('section')!

afterEach(cleanup)

describe('printing the contract', () => {
  it('leaves every part of the contract in the printout', () => {
    // The regression itself: a print rule that hid or removed anything here.
    openContract()
    const everything = [article(), ...article().querySelectorAll('*')]
    for (const el of everything) {
      expect(removedInPrint(rules, el), `<${el.tagName.toLowerCase()}> "${el.textContent?.slice(0, 40)}" is removed`).toBe(false)
      expect(hiddenInPrint(rules, el), `<${el.tagName.toLowerCase()}> "${el.textContent?.slice(0, 40)}" is hidden`).toBe(false)
    }
    // And the shell around it.
    for (let el: Element | null = article(); el && el !== document.body; el = el.parentElement) {
      expect(removedInPrint(rules, el), `<${el.tagName.toLowerCase()}> around the contract is removed`).toBe(false)
      expect(hiddenInPrint(rules, el), `<${el.tagName.toLowerCase()}> around the contract is hidden`).toBe(false)
    }
  })

  it('carries the content that has to reach paper', () => {
    openContract()
    for (const expected of [
      'JMAC-2026-0007', 'Maria Dela Cruz', 'Store Cashier', 'TERMS-TEXT', 'POLICIES-TEXT',
      'NOTES-TEXT', 'HR Signature', 'Signed by Ana Reyes',
    ]) {
      expect(article().textContent, expected).toContain(expected)
    }
  })

  it('keeps the app around it out of the printout', () => {
    openContract()
    expect(screen.getByTestId('sidebar').className).toContain('print:hidden')
    expect(screen.getByTestId('navbar').className).toContain('print:hidden')
    // Back and Print sit in one bar, outside the contract, hidden in print.
    const bar = screen.getByRole('button', { name: /Print \/ Save as PDF/ }).parentElement!
    expect(bar.className).toContain('print:hidden')
    expect(article().contains(bar)).toBe(false)
  })

  it('prints on A4 portrait', () => {
    openContract()
    const onArticle = Object.assign({}, ...rulesFor(rules, article()).map((rule) => rule.declarations))
    expect(onArticle.page).toBe('contract')
    expect(pageRule(css, 'contract')).toMatchObject({ size: 'A4 portrait' })
    // The page margins replace the card's padding, so every sheet matches.
    expect(article().className).toContain('print:p-0')
  })

  it('drops the dashboard shell\'s flex layout in print', () => {
    // With flex nested in flex, Chrome cut printed text lines in half at the
    // page edges. jsdom cannot paginate, so this pins the fix where it lives:
    // every flex box between <body> and the contract is a block in print.
    openContract()
    const shellFlex = []
    for (let el: Element | null = article().parentElement; el && el !== document.body; el = el.parentElement) {
      if (/(^|\s)flex(\s|$)/.test(el.className)) shellFlex.push(el)
    }
    expect(shellFlex.length).toBeGreaterThan(0)
    for (const el of shellFlex) expect(el.className, el.className).toContain('print:block')
  })

  it('keeps small blocks whole, and never the long ones', () => {
    openContract()
    // The signatures stay together, and stay with "IN WITNESS WHEREOF".
    const signatures = sectionWith('^HR Signature$')
    expect(signatures.className).toContain('print:break-inside-avoid')
    expect(signatures.className).toContain('print:break-before-avoid')
    expect(sectionWith('^Acknowledgement$').className).toContain('print:break-inside-avoid')
    expect(sectionWith('^Employee Name$').className).toContain('print:break-inside-avoid')
    // Terms and policies run for pages: refusing to split them would push
    // them whole onto the next sheet and leave blank space behind.
    expect(sectionWith('TERMS-TEXT').className).not.toContain('break-inside-avoid')
    expect(sectionWith('POLICIES-TEXT').className).not.toContain('break-inside-avoid')
  })
})
