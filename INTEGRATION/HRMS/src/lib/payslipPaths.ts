import { ESS_PREFIX } from '@/lib/portals'

/**
 * Where a payslip opens, by where it is opened from.
 *
 * One payslip, two addresses, because it is looked at in two contexts. HR opens
 * any employee's from Payroll and stays in Human Resources. Anybody opens their
 * own from My Payroll and stays in My Workspace -- an HR Manager or an
 * Accountant included, since they are employees too. The shell is chosen from
 * the address (portalForPath), so the self-service one sits under ESS_PREFIX,
 * and that is what keeps somebody in My Workspace on a refresh or a pasted link
 * as much as after a click.
 *
 * Both addresses render the same payslip; each knows where Back goes.
 */
export const HR_PAYROLL_PATH = '/dashboard/payroll'
export const MY_PAYROLL_PATH = `${ESS_PREFIX}payroll`

export function hrPayslipPath(recordId: string): string {
  return `${HR_PAYROLL_PATH}/${recordId}/payslip`
}

export function myPayslipPath(recordId: string): string {
  return `${MY_PAYROLL_PATH}/${recordId}/payslip`
}
