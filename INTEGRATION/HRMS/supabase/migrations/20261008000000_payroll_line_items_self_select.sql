-- Employees can read the lines of their own released payslip.
--
-- The self-service policies (20260716063417, narrowed to released payroll in
-- 20260729090000 and restored in 20260731010000) gave employees their own
-- payroll_records and payslips, but never payroll_line_items. Its only SELECT
-- policy was payroll_line_items_staff_select -- is_active_staff(), HR and
-- admin -- so every other account read none of its own lines. A cashier's or an
-- accountant's payslip said "No deductions" directly above a Total Deductions of
-- 26,432.95: the total comes from payroll_records, the breakdown from here.
--
-- Checked in production before writing this:
--   - RLS is enabled on payroll_line_items, and no other policy grants SELECT;
--   - its columns are id, payroll_record_id, item_type, label, amount and
--     created_at -- no HR-only notes or authorship to keep back;
--   - item_type is CHECKed to 'allowance' or 'deduction', the two kinds of line
--     a payslip prints, so there is no internal line type to filter out;
--   - every record's deduction lines add up exactly to its total_deductions.
--
-- The rule is the one payslips_self_select already applies: an active
-- employee, a payroll record that is theirs, and only once it is released. The
-- lines of a payroll still being prepared or approved stay HR's until then.
--
-- Additive. HR keeps payroll_line_items_staff_select, untouched; policies are
-- permissive, so this widens nothing for HR, and it grants SELECT only --
-- inserts, updates and deletes keep their own policies.
--
-- Like payslips_self_select, this names 'released'::public.payroll_status, so a
-- migration that rebuilds that type has to drop and restore it as well (see
-- 20260731010000).
create policy payroll_line_items_self_select on public.payroll_line_items
  for select to authenticated using (
    public.is_active_employee()
    and payroll_record_id in (
      select id from public.payroll_records
      where employee_id = public.my_employee_id()
        and status = 'released'::public.payroll_status
    )
  );
