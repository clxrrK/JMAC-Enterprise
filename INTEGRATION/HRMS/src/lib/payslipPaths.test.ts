import { describe, expect, it } from 'vitest'
import { portalForPath } from '@/lib/portals'
import { HR_PAYROLL_PATH, MY_PAYROLL_PATH, hrPayslipPath, myPayslipPath } from '@/lib/payslipPaths'

/**
 * A payslip's address decides the shell it opens in, so the two addresses have
 * to land in the two portals they are named for. App.payslip.test.tsx follows
 * them through the real route table; this pins the agreement with
 * portalForPath on its own.
 */
describe('the two payslip addresses', () => {
  it("keeps HR's in Human Resources", () => {
    expect(hrPayslipPath('r1')).toBe('/dashboard/payroll/r1/payslip')
    expect(portalForPath(hrPayslipPath('r1'))).toBe('admin')
    expect(portalForPath(HR_PAYROLL_PATH)).toBe('admin')
  })

  it("keeps an employee's own in My Workspace", () => {
    expect(myPayslipPath('r1')).toBe('/dashboard/my-payroll/r1/payslip')
    expect(portalForPath(myPayslipPath('r1'))).toBe('employee')
    expect(portalForPath(MY_PAYROLL_PATH)).toBe('employee')
  })
})
