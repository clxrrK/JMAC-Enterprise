import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import type { Tables, TablesInsert } from '@/lib/database.types'
import type { EmploymentStatus } from '@/lib/enums'
import { toast } from '@/components/ui/sonner'
import { invalidateEmployeePortal } from '@/lib/employeePortalQueries'
import { fetchEffectiveSchedule } from '@/hooks/useAttendance'
import { PAYROLL_AUDIT_ACTION } from '@/lib/payrollLabels'
import {
  dateRangesOverlap,
  countScheduledWorkingDays,
  calculateDailyRate,
  calculateHourlyRate,
  calculateOvertimePay,
  calculateLateDeduction,
  calculateUndertimeDeduction,
  calculateAbsenceDeduction,
  calculateLeaveWithoutPayDeduction,
  calculateGrossSalary,
  calculateNetSalary,
} from '@/lib/payrollCalculations'
import { calculateStatutoryContributions, periodsPerMonth } from '@/lib/statutoryContributions'

const STANDARD_WORKING_DAYS_PER_MONTH = 22

export type PayrollPeriod = Tables<'payroll_periods'>
export type PayrollLineItem = Tables<'payroll_line_items'>

export type PayrollEmployee = Pick<
  Tables<'employees'>,
  'id' | 'employee_number' | 'first_name' | 'last_name' | 'email' | 'department_id' | 'position_id' | 'employment_status' | 'employment_type'
> & {
  departments: { id: string; name: string } | null
  positions: { id: string; title: string } | null
}

export type PayrollRecord = Tables<'payroll_records'> & {
  employees: PayrollEmployee
  payroll_line_items: PayrollLineItem[]
  payslips: Tables<'payslips'>[]
}

function byCreatedAtDesc<T extends { created_at: string }>(rows: T[] | null | undefined): T[] {
  return [...(rows ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export function getLatestPayslip(record: { payslips: Tables<'payslips'>[] }): Tables<'payslips'> | null {
  return byCreatedAtDesc(record.payslips)[0] ?? null
}

export function usePayrollPeriods() {
  return useQuery({
    queryKey: ['payroll-periods'],
    queryFn: async () => {
      const { data, error } = await supabase.from('payroll_periods').select('*').order('period_start', { ascending: false })
      if (error) throw error
      return data
    },
  })
}

const RECORD_SELECT = `
  *,
  employees (
    id, employee_number, first_name, last_name, email, department_id, position_id, employment_status, employment_type,
    departments (id, name),
    positions (id, title)
  ),
  payroll_line_items (*),
  payslips (*)
`

export function usePayrollRecords(periodId: string | undefined) {
  return useQuery({
    queryKey: ['payroll-records', periodId],
    queryFn: async () => {
      const { data, error } = await supabase.from('payroll_records').select(RECORD_SELECT).eq('payroll_period_id', periodId as string)
      if (error) throw error
      return data as unknown as PayrollRecord[]
    },
    enabled: !!periodId,
  })
}

export function usePayrollRecord(id: string | undefined) {
  return useQuery({
    queryKey: ['payroll-record', id],
    queryFn: async () => {
      const { data, error } = await supabase.from('payroll_records').select(RECORD_SELECT).eq('id', id as string).maybeSingle()
      if (error) throw error
      return data as unknown as PayrollRecord | null
    },
    enabled: !!id,
  })
}

/**
 * A payslip opened from My Workspace: the signed-in person's own released
 * record, and nothing else.
 *
 * RLS already holds most accounts to that -- their own records, released only --
 * but it lets HR read everybody's, because HR Payroll has to. My Workspace is
 * about the person signed in whatever else they do, so this asks for their
 * record rather than trusting the id in the address: an HR Manager who pastes a
 * colleague's id here gets "not available", and opens that payslip from HR
 * Payroll instead.
 */
export function useMyPayrollRecord(id: string | undefined) {
  const { profile } = useAuth()
  const employeeId = profile?.employee_id
  return useQuery({
    queryKey: ['my-payroll-record', employeeId, id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payroll_records')
        .select(RECORD_SELECT)
        .eq('id', id as string)
        .eq('employee_id', employeeId as string)
        .eq('status', 'released')
        .maybeSingle()
      if (error) throw error
      return data as unknown as PayrollRecord | null
    },
    enabled: !!id && !!employeeId,
  })
}

export function usePayrollPeriodStats(periodId: string | undefined) {
  return useQuery({
    queryKey: ['payroll-period-stats', periodId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payroll_records')
        .select('gross_salary, total_deductions, net_salary, status')
        .eq('payroll_period_id', periodId as string)
      if (error) throw error

      return {
        employeesIncluded: data.length,
        grossPayroll: data.reduce((sum, r) => sum + Number(r.gross_salary), 0),
        totalDeductions: data.reduce((sum, r) => sum + Number(r.total_deductions), 0),
        totalNetPayroll: data.reduce((sum, r) => sum + Number(r.net_salary), 0),
        payslipsReleased: data.filter((r) => r.status === 'released').length,
      }
    },
    enabled: !!periodId,
  })
}

function useInvalidatePayroll() {
  const queryClient = useQueryClient()
  return (periodId?: string, recordId?: string) => {
    queryClient.invalidateQueries({ queryKey: ['payroll-periods'] })
    // A released payroll becomes visible in the Employee Portal.
    invalidateEmployeePortal(queryClient)
    if (periodId) {
      queryClient.invalidateQueries({ queryKey: ['payroll-records', periodId] })
      queryClient.invalidateQueries({ queryKey: ['payroll-period-stats', periodId] })
    }
    if (recordId) {
      queryClient.invalidateQueries({ queryKey: ['payroll-record', recordId] })
      queryClient.invalidateQueries({ queryKey: ['payroll-audit-log', recordId] })
    }
  }
}

// ---- Step 1: Create Payroll Period ----

export interface CreatePayrollPeriodInput {
  periodStart: string
  periodEnd: string
  payDate?: string
  frequency: 'weekly' | 'biweekly' | 'semi_monthly' | 'monthly'
}

export function useCreatePayrollPeriod() {
  const { profile } = useAuth()
  const invalidate = useInvalidatePayroll()
  return useMutation({
    mutationFn: async (input: CreatePayrollPeriodInput) => {
      if (input.periodStart > input.periodEnd) throw new Error('End Date cannot be earlier than Start Date.')

      const { data: existing, error: existingError } = await supabase.from('payroll_periods').select('period_start, period_end')
      if (existingError) throw existingError

      const overlaps = existing.some((p) => dateRangesOverlap(input.periodStart, input.periodEnd, p.period_start, p.period_end))
      if (overlaps) throw new Error('This payroll period overlaps an existing payroll period.')

      const { data, error } = await supabase
        .from('payroll_periods')
        .insert({
          period_start: input.periodStart,
          period_end: input.periodEnd,
          pay_date: input.payDate || null,
          frequency: input.frequency,
          status: 'draft',
          created_by: profile?.id,
        })
        .select('id')
        .single()
      if (error) throw error
      return data
    },
    onSuccess: () => {
      invalidate()
      toast.success('Payroll period created')
    },
    onError: (error) => toast.error(error.message),
  })
}

// ---- Steps 2-10: Generate Payroll ----

const ACTIVE_EMPLOYMENT_STATUSES: EmploymentStatus[] = ['active', 'on_leave']

export function useGeneratePayroll() {
  const { profile } = useAuth()
  const invalidate = useInvalidatePayroll()
  return useMutation({
    mutationFn: async ({ periodId }: { periodId: string }) => {
      const { data: period, error: periodError } = await supabase
        .from('payroll_periods')
        .select('period_start, period_end, frequency')
        .eq('id', periodId)
        .single()
      if (periodError) throw periodError

      const { data: employees, error: employeesError } = await supabase
        .from('employees')
        .select(
          'id, first_name, last_name, basic_salary, currency, employment_type, work_schedule_id, salary_grade_id, work_schedules(employment_type), salary_grades(employment_type)'
        )
        .in('employment_status', ACTIVE_EMPLOYMENT_STATUSES)
      if (employeesError) throw employeesError
      if (employees.length === 0) throw new Error('No active employees to include in this payroll.')

      let includedCount = 0
      for (const employee of employees) {
        const { data: existingRecord } = await supabase
          .from('payroll_records')
          .select('id')
          .eq('payroll_period_id', periodId)
          .eq('employee_id', employee.id)
          .maybeSingle()
        if (existingRecord) continue // already generated for this employee — skip rather than duplicate

        // Rates are derived from the employee's own shift and pay band, so a
        // mismatched pairing doesn't fail loudly — it quietly pays a part-timer
        // at full-time hours, or the reverse. Triggers stop new mismatches
        // being stored; this catches any that predate them, and refuses rather
        // than computing something wrong.
        const who = `${employee.first_name} ${employee.last_name}`
        const scheduleType = (employee.work_schedules as { employment_type: string } | null)?.employment_type
        const gradeType = (employee.salary_grades as { employment_type: string } | null)?.employment_type
        if (scheduleType && scheduleType !== employee.employment_type) {
          throw new Error(`Work schedule does not match the employee's employment type (${who}).`)
        }
        if (gradeType && gradeType !== employee.employment_type) {
          throw new Error(`Salary grade does not match the employee's employment type (${who}).`)
        }

        const schedule = await fetchEffectiveSchedule(employee.id)
        const workingDays = countScheduledWorkingDays(period.period_start, period.period_end, schedule)
        const dailyRate = calculateDailyRate(Number(employee.basic_salary), STANDARD_WORKING_DAYS_PER_MONTH)
        const hourlyRate = calculateHourlyRate(dailyRate, schedule)

        const { data: attendanceRows, error: attendanceError } = await supabase
          .from('attendance_records')
          .select('attendance_date, status, late_minutes, undertime_minutes, overtime_minutes')
          .eq('employee_id', employee.id)
          .gte('attendance_date', period.period_start)
          .lte('attendance_date', period.period_end)
        if (attendanceError) throw attendanceError

        const daysPresent = attendanceRows.filter((r) => ['present', 'late', 'half_day', 'work_from_home'].includes(r.status)).length
        const explicitAbsentDays = attendanceRows.filter((r) => r.status === 'absent').length
        const recordedDates = new Set(attendanceRows.map((r) => r.attendance_date))

        // A scheduled working day with no attendance record counts as an
        // absence — but only once the day is actually over. Scanning to
        // period_end would bill every remaining day of the month as an absence
        // whenever payroll is generated mid-period, and including today would
        // mark someone absent for a shift they may still be working. So the
        // scan stops at yesterday (or period_end, whichever comes first).
        const yesterday = new Date()
        yesterday.setDate(yesterday.getDate() - 1)
        const yesterdayIso = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`
        const lastDayToCheck = period.period_end < yesterdayIso ? period.period_end : yesterdayIso
        let unrecordedAbsentDays = 0
        const cursor = new Date(`${period.period_start}T00:00:00`)
        const end = new Date(`${lastDayToCheck}T00:00:00`)
        while (cursor.getTime() <= end.getTime()) {
          const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
          if (!recordedDates.has(iso)) {
            const weekday = cursor.getDay()
            if (schedule.working_days.includes(weekday)) unrecordedAbsentDays++
          }
          cursor.setDate(cursor.getDate() + 1)
        }
        const absentDays = explicitAbsentDays + unrecordedAbsentDays
        const lateMinutes = attendanceRows.reduce((sum, r) => sum + r.late_minutes, 0)
        const undertimeMinutes = attendanceRows.reduce((sum, r) => sum + r.undertime_minutes, 0)
        const overtimeHours = attendanceRows.reduce((sum, r) => sum + r.overtime_minutes / 60, 0)

        const { data: leaveRequests, error: leaveError } = await supabase
          .from('leave_requests')
          .select('start_date, end_date, leave_types(is_paid)')
          .eq('employee_id', employee.id)
          .eq('status', 'approved')
          .lte('start_date', period.period_end)
          .gte('end_date', period.period_start)
        if (leaveError) throw leaveError

        let paidLeaveDays = 0
        let unpaidLeaveDays = 0
        for (const leave of leaveRequests) {
          const clippedStart = leave.start_date > period.period_start ? leave.start_date : period.period_start
          const clippedEnd = leave.end_date < period.period_end ? leave.end_date : period.period_end
          const days = Math.round((new Date(`${clippedEnd}T00:00:00`).getTime() - new Date(`${clippedStart}T00:00:00`).getTime()) / 86400000) + 1
          const isPaid = (leave.leave_types as unknown as { is_paid: boolean } | null)?.is_paid ?? true
          if (isPaid) paidLeaveDays += days
          else unpaidLeaveDays += days
        }

        const overtimePay = calculateOvertimePay(overtimeHours, hourlyRate)
        const lateDeduction = calculateLateDeduction(lateMinutes, hourlyRate)
        const undertimeDeduction = calculateUndertimeDeduction(undertimeMinutes, hourlyRate)
        const absenceDeduction = calculateAbsenceDeduction(absentDays, dailyRate)
        const leaveDeduction = calculateLeaveWithoutPayDeduction(unpaidLeaveDays, dailyRate)

        // Statutory contributions are monthly figures set by the agencies, so
        // they're computed from the employee's monthly basic salary and
        // pro-rated for shorter runs — a weekly payroll must not deduct a full
        // month of SSS.
        const statutory = calculateStatutoryContributions(
          Number(employee.basic_salary),
          periodsPerMonth(period.frequency)
        )

        const totalAllowances = overtimePay
        const totalDeductions =
          lateDeduction + undertimeDeduction + absenceDeduction + leaveDeduction + statutory.total
        const periodBasicSalary = Math.round(dailyRate * workingDays * 100) / 100
        const grossSalary = calculateGrossSalary(periodBasicSalary, totalAllowances)
        const netSalary = calculateNetSalary(grossSalary, totalDeductions)

        const { data: record, error: recordError } = await supabase
          .from('payroll_records')
          .insert({
            payroll_period_id: periodId,
            employee_id: employee.id,
            basic_salary: periodBasicSalary,
            currency: employee.currency,
            total_allowances: totalAllowances,
            overtime_pay: overtimePay,
            gross_salary: grossSalary,
            late_deduction: lateDeduction,
            undertime_deduction: undertimeDeduction,
            leave_deduction: leaveDeduction,
            sss_contribution: statutory.sss,
            philhealth_contribution: statutory.philHealth,
            pagibig_contribution: statutory.pagIbig,
            other_deductions: 0,
            total_deductions: totalDeductions,
            net_salary: netSalary,
            working_days: workingDays,
            days_present: daysPresent,
            absent_days: absentDays,
            late_minutes: lateMinutes,
            undertime_minutes: undertimeMinutes,
            overtime_hours: overtimeHours,
            paid_leave_days: paidLeaveDays,
            unpaid_leave_days: unpaidLeaveDays,
            status: 'generated',
          })
          .select('id')
          .single()
        if (recordError) throw recordError

        const lineItems: TablesInsert<'payroll_line_items'>[] = []
        if (overtimePay > 0) lineItems.push({ payroll_record_id: record.id, item_type: 'allowance', label: 'Overtime Pay', amount: overtimePay })
        if (lateDeduction > 0) lineItems.push({ payroll_record_id: record.id, item_type: 'deduction', label: 'Late Deduction', amount: lateDeduction })
        if (undertimeDeduction > 0) lineItems.push({ payroll_record_id: record.id, item_type: 'deduction', label: 'Undertime Deduction', amount: undertimeDeduction })
        if (absenceDeduction > 0) lineItems.push({ payroll_record_id: record.id, item_type: 'deduction', label: 'Absences', amount: absenceDeduction })
        if (leaveDeduction > 0) lineItems.push({ payroll_record_id: record.id, item_type: 'deduction', label: 'Leave Without Pay', amount: leaveDeduction })
        // Statutory contributions are itemised so the payslip shows exactly
        // what was withheld and under which programme.
        if (statutory.sss > 0) lineItems.push({ payroll_record_id: record.id, item_type: 'deduction', label: 'SSS Contribution', amount: statutory.sss })
        if (statutory.philHealth > 0) lineItems.push({ payroll_record_id: record.id, item_type: 'deduction', label: 'PhilHealth Contribution', amount: statutory.philHealth })
        if (statutory.pagIbig > 0) lineItems.push({ payroll_record_id: record.id, item_type: 'deduction', label: 'Pag-IBIG Contribution', amount: statutory.pagIbig })
        if (lineItems.length > 0) {
          const { error: lineItemsError } = await supabase.from('payroll_line_items').insert(lineItems)
          if (lineItemsError) throw lineItemsError
        }

        includedCount++
      }

      await supabase.from('audit_logs').insert({
        actor_id: profile?.id,
        action: 'Payroll Generated',
        table_name: 'payroll_periods',
        record_id: periodId,
        new_data: { employees_included: includedCount },
      })

      return { includedCount }
    },
    onSuccess: ({ includedCount }, { periodId }) => {
      invalidate(periodId)
      toast.success(`Payroll generated for ${includedCount} employee${includedCount === 1 ? '' : 's'}.`)
    },
    onError: (error) => toast.error(error.message),
  })
}

// ---- Steps 11-12: HR Reviews Payroll ----

/** HR Staff hands the whole computed period to the HR Manager. This is the one
 * batch action left in the workflow, and deliberately so: submitting isn't a
 * decision, it's "I've finished checking these". The decisions that follow are
 * taken one employee at a time. */
export function useSubmitPayrollForApproval() {
  const { profile } = useAuth()
  const invalidate = useInvalidatePayroll()
  return useMutation({
    mutationFn: async ({ periodId }: { periodId: string }) => {
      const { data: updated, error } = await supabase
        .from('payroll_records')
        .update({ status: 'pending_approval', submitted_by: profile?.id, submitted_at: new Date().toISOString(), rejection_reason: null })
        .eq('payroll_period_id', periodId)
        .in('status', ['draft', 'generated', 'rejected'])
        .select('id')
      if (error) throw error
      if (!updated?.length) throw new Error('There is nothing left to submit for this period.')

      await supabase.from('audit_logs').insert({
        actor_id: profile?.id,
        action: PAYROLL_AUDIT_ACTION.submitted,
        table_name: 'payroll_periods',
        record_id: periodId,
        new_data: { records_submitted: updated.length },
      })
      return updated.length
    },
    onSuccess: (count, { periodId }) => {
      invalidate(periodId)
      toast.success(`${count} payroll ${count === 1 ? 'record' : 'records'} submitted for approval.`)
    },
    onError: (error) => toast.error(error.message),
  })
}

/** One employee's payroll, approved on its own. There is no "approve all" —
 * the point of the review step is that a manager looked at each figure. */
export function useApprovePayrollRecord() {
  const { profile } = useAuth()
  const invalidate = useInvalidatePayroll()
  return useMutation({
    mutationFn: async ({ recordId }: { recordId: string; periodId: string }) => {
      const { error } = await supabase
        .from('payroll_records')
        .update({ status: 'approved', reviewed_by: profile?.id, reviewed_at: new Date().toISOString(), rejection_reason: null })
        .eq('id', recordId)
        .eq('status', 'pending_approval')
      if (error) throw error

      await supabase.from('audit_logs').insert({
        actor_id: profile?.id,
        action: PAYROLL_AUDIT_ACTION.approved,
        table_name: 'payroll_records',
        record_id: recordId,
      })
    },
    onSuccess: (_data, { periodId, recordId }) => {
      invalidate(periodId, recordId)
      toast.success('Payroll approved for this employee.')
    },
    onError: (error) => toast.error(error.message),
  })
}

/** Sends one record back to HR Staff. The reason is what makes the return
 * actionable, so it's required here and again in a database trigger. */
export function useRejectPayrollRecord() {
  const { profile } = useAuth()
  const invalidate = useInvalidatePayroll()
  return useMutation({
    mutationFn: async ({ recordId, reason }: { recordId: string; periodId: string; reason: string }) => {
      if (!reason.trim()) throw new Error('A reason is required when rejecting payroll.')

      const { error } = await supabase
        .from('payroll_records')
        .update({ status: 'rejected', reviewed_by: profile?.id, reviewed_at: new Date().toISOString(), rejection_reason: reason.trim() })
        .eq('id', recordId)
        .eq('status', 'pending_approval')
      if (error) throw error

      await supabase.from('audit_logs').insert({
        actor_id: profile?.id,
        action: PAYROLL_AUDIT_ACTION.rejected,
        table_name: 'payroll_records',
        record_id: recordId,
        new_data: { reason: reason.trim() },
      })
    },
    onSuccess: (_data, { periodId, recordId }) => {
      invalidate(periodId, recordId)
      toast.success('Payroll sent back to HR Staff.')
    },
    onError: (error) => toast.error(error.message),
  })
}

// ---- Step 13: Edit / Adjust Payroll ----

export interface AddPayrollLineItemInput {
  recordId: string
  periodId: string
  itemType: 'allowance' | 'deduction'
  label: string
  amount: number
  reason: string
  notes?: string
}

export function useAddPayrollLineItem() {
  const { profile } = useAuth()
  const invalidate = useInvalidatePayroll()
  return useMutation({
    mutationFn: async (input: AddPayrollLineItemInput) => {
      const { data: record, error: recordError } = await supabase
        .from('payroll_records')
        .select('gross_salary, total_deductions, net_salary, total_allowances, other_deductions')
        .eq('id', input.recordId)
        .single()
      if (recordError) throw recordError

      const { error: lineItemError } = await supabase.from('payroll_line_items').insert({
        payroll_record_id: input.recordId,
        item_type: input.itemType,
        label: input.label,
        amount: input.amount,
      })
      if (lineItemError) throw lineItemError

      const isAllowance = input.itemType === 'allowance'
      const newAllowances = isAllowance ? Number(record.total_allowances) + input.amount : Number(record.total_allowances)
      const newOtherDeductions = isAllowance ? Number(record.other_deductions) : Number(record.other_deductions) + input.amount
      const newDeductions = isAllowance ? Number(record.total_deductions) : Number(record.total_deductions) + input.amount
      const newGross = isAllowance ? Number(record.gross_salary) + input.amount : Number(record.gross_salary)
      const newNet = calculateNetSalary(newGross, newDeductions)

      const { error: updateError } = await supabase
        .from('payroll_records')
        .update({
          total_allowances: newAllowances,
          other_deductions: newOtherDeductions,
          total_deductions: newDeductions,
          gross_salary: newGross,
          net_salary: newNet,
          notes: input.notes || null,
          // Editing a figure invalidates whatever decision was made about it,
          // so the record goes back to HR Staff's side of the workflow and has
          // to be submitted again. Only this employee's record moves — the
          // rest of the period is unaffected.
          status: 'generated',
          submitted_at: null,
          reviewed_at: null,
          rejection_reason: null,
        })
        .eq('id', input.recordId)
      if (updateError) throw updateError

      await supabase.from('audit_logs').insert({
        actor_id: profile?.id,
        action: 'Payroll Adjusted',
        table_name: 'payroll_records',
        record_id: input.recordId,
        old_data: { net_salary: record.net_salary },
        new_data: { net_salary: newNet, added: { type: input.itemType, label: input.label, amount: input.amount }, reason: input.reason },
      })
    },
    onSuccess: (_data, { periodId, recordId }) => {
      invalidate(periodId, recordId)
      toast.success('Payroll record adjusted')
    },
    onError: (error) => toast.error(error.message),
  })
}

// ---- Steps 14-16: Generate Payslip, Release, Save ----

/**
 * Release one payroll period.
 *
 * One call, because release is one act. This used to be four round trips: read
 * the period, read its approved records, insert a payslip per record in a loop,
 * then flip the records to released. The payslip inserts DISCARDED their errors
 * — `await supabase.from('payslips').insert(...)` with the result thrown away —
 * so payroll released whether or not the employees got payslips, and with no
 * uniqueness on payslips.payroll_record_id a retry issued them twice.
 *
 * release_payroll_period does all of it inside one transaction: every payslip,
 * every record, the period, and the Finance snapshot. Any failure takes the
 * whole thing with it, so there is no longer a state where payroll is half
 * released. Retrying a period that already released returns its existing
 * Finance batch rather than doing anything again.
 *
 * Authority is unchanged — the RPC re-checks is_hr_manager_or_admin(), the same
 * rule protect_payroll_approval has always enforced.
 */
export function useReleasePayroll() {
  const invalidate = useInvalidatePayroll()
  return useMutation({
    mutationFn: async ({ periodId }: { periodId: string }) => {
      const { data, error } = await supabase.rpc('release_payroll_period', {
        _period_id: periodId,
      })
      if (error) throw error
      return data as string | null
    },
    onSuccess: (_data, { periodId }) => {
      invalidate(periodId)
      toast.success('Payroll released. Payslips are issued and Finance has the batch.')
    },
    // The server's message, which names what stopped it — which employee is
    // not approved, or which payslip is missing. Replacing it with "Release
    // failed" would throw away the only useful part.
    onError: (error) => toast.error(error.message || 'Payroll could not be released.'),
  })
}

export function usePayrollAuditLog(recordId: string | undefined) {
  return useQuery({
    queryKey: ['payroll-audit-log', recordId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*, actor:profiles(full_name)')
        .eq('table_name', 'payroll_records')
        .eq('record_id', recordId as string)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data
    },
    enabled: !!recordId,
  })
}

export function usePayrollRealtimeAlerts() {
  const queryClient = useQueryClient()
  React.useEffect(() => {
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-periods'] })
      queryClient.invalidateQueries({ queryKey: ['payroll-records'] })
      queryClient.invalidateQueries({ queryKey: ['payroll-period-stats'] })
    }
    const channel = supabase
      .channel('payroll-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payroll_records' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payroll_periods' }, refresh)
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [queryClient])
}
