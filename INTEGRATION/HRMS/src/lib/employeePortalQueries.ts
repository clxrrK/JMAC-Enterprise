import type { QueryClient } from '@tanstack/react-query'

/**
 * The Employee Portal reads the same tables as the HR modules, but through its
 * own `my-*` query keys. A mutation from either side therefore has to
 * invalidate both sets — otherwise the other view keeps serving cached rows
 * and the user has to refresh by hand to see a change they just made.
 *
 * Keeping the list in one place means a new portal query only has to be
 * registered here, rather than remembered at every HR-side call site.
 */
export const EMPLOYEE_PORTAL_QUERY_KEYS: string[][] = [
  ['my-employee-record'],
  ['my-today-attendance'],
  ['my-attendance-month-summary'],
  ['my-attendance-records'],
  ['my-payroll-records'],
  ['my-payroll-record'],
  ['my-leave-requests'],
  ['my-leave-balances'],
  ['my-activity'],
]

export function invalidateEmployeePortal(queryClient: QueryClient) {
  for (const queryKey of EMPLOYEE_PORTAL_QUERY_KEYS) {
    queryClient.invalidateQueries({ queryKey })
  }
}
