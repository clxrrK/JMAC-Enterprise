-- Who can read a payslip's lines: checked as each role, read-only.
--
-- Changes nothing. It builds a temporary approved-but-unreleased payroll for a
-- cashier, then reads payroll_line_items as one real account per role -- as
-- that account (its JWT claims, role authenticated), so RLS decides -- and ends
-- by raising an exception that carries the results, which rolls everything
-- back, the temporary payroll included. Run it in the Supabase SQL editor for
-- project joffopwzqmlqpsrbivfq; the "error" it ends with is the report.
--
-- Selects no names, emails or ids: per role, counts and peso amounts only.
--
-- What it should say, since 20261008000000_payroll_line_items_self_select:
--   own_lines                 n/n for everyone -- their own released lines
--   own_lines_sum             equal to own_total_deductions
--   other_employee_lines      0/n except hr_staff and hr_manager
--   cashier_unreleased_lines  0/2 except hr_staff and hr_manager -- the
--                             cashier included: not released, not theirs yet
--   all_lines_visible         their own lines only, except HR, who see all
-- Before that migration, every role outside HR read 0 of its own lines.
do $$
declare
  s record;
  cashier_emp uuid;
  hr_manager_profile uuid;
  tmp_period uuid;
  tmp_rec uuid;
  tmp_status text;
  own_rec uuid; own_actual int;
  other_rec uuid; other_actual int;
  results jsonb := '[]'::jsonb;
  one jsonb;
begin
  -- A payroll for a real cashier that is NOT released. Generated with no
  -- session (maintenance), then approved as the HR Manager, as in the app.
  select pr.employee_id into cashier_emp
  from public.profiles pr
  where pr.role = 'employee' and pr.status = 'active' and pr.employee_id is not null
    and exists (select 1 from public.pos_branch_assignments a
                where a.profile_id = pr.id and a.pos_role::text = 'cashier' and a.status::text = 'active')
  order by pr.created_at limit 1;
  select pr.id into hr_manager_profile from public.profiles pr
   where pr.role = 'hr_manager' and pr.status = 'active' order by pr.created_at limit 1;

  insert into public.payroll_periods (period_start, period_end, pay_date, frequency)
  values ('2027-01-01', '2027-01-15', '2027-01-20', 'monthly') returning id into tmp_period;
  insert into public.payroll_records (payroll_period_id, employee_id, basic_salary, gross_salary, total_deductions, net_salary, status, currency)
  values (tmp_period, cashier_emp, 1000, 1000, 100, 900, 'pending_approval', 'PHP') returning id into tmp_rec;
  insert into public.payroll_line_items (payroll_record_id, item_type, label, amount)
  values (tmp_rec, 'deduction', 'SSS Contribution', 60), (tmp_rec, 'deduction', 'PhilHealth Contribution', 40);
  tmp_status := 'pending_approval';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', hr_manager_profile, 'role', 'authenticated')::text, true);
    update public.payroll_records set status = 'approved', reviewed_by = hr_manager_profile, reviewed_at = now() where id = tmp_rec;
    tmp_status := 'approved';
  exception when others then
    tmp_status := 'pending_approval (approval refused: ' || sqlerrm || ')';
  end;
  perform set_config('request.jwt.claims', '', true);

  -- One account per role that has a released payslip. A cashier and a POS
  -- manager hold the 'employee' role; their POS assignment tells them apart.
  for s in
    select distinct on (label) label, profile_id, employee_id
    from (
      select case
               when pr.role = 'employee' and exists (select 1 from public.pos_branch_assignments a where a.profile_id = pr.id and a.pos_role::text = 'cashier' and a.status::text = 'active') then 'cashier'
               when pr.role = 'employee' and exists (select 1 from public.pos_branch_assignments a where a.profile_id = pr.id and a.pos_role::text = 'manager' and a.status::text = 'active') then 'pos_manager'
               else pr.role::text
             end as label,
             pr.id as profile_id, pr.employee_id, pr.created_at
      from public.profiles pr
      where pr.status = 'active' and pr.employee_id is not null
        and exists (select 1 from public.payroll_records r where r.employee_id = pr.employee_id and r.status = 'released')
    ) z
    order by label, created_at
  loop
    select r.id into own_rec from public.payroll_records r
     where r.employee_id = s.employee_id and r.status = 'released' order by r.created_at limit 1;
    select count(*) into own_actual from public.payroll_line_items where payroll_record_id = own_rec;
    select r.id into other_rec from public.payroll_records r
     where r.employee_id <> s.employee_id and r.status = 'released' order by r.created_at limit 1;
    select count(*) into other_actual from public.payroll_line_items where payroll_record_id = other_rec;

    perform set_config('request.jwt.claims', json_build_object('sub', s.profile_id, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select jsonb_build_object(
      'as', s.label,
      'own_lines', (select count(*) from public.payroll_line_items where payroll_record_id = own_rec) || '/' || own_actual,
      'own_lines_sum', (select coalesce(sum(amount), 0) from public.payroll_line_items where payroll_record_id = own_rec and item_type = 'deduction'),
      'own_total_deductions', (select total_deductions from public.payroll_records where id = own_rec),
      'other_employee_lines', (select count(*) from public.payroll_line_items where payroll_record_id = other_rec) || '/' || other_actual,
      'cashier_unreleased_lines', (select count(*) from public.payroll_line_items where payroll_record_id = tmp_rec) || '/2',
      'all_lines_visible', (select count(*) from public.payroll_line_items)
    ) into one;
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    results := results || jsonb_build_array(one);
  end loop;

  raise exception 'RLS_CHECK %', jsonb_build_object('unreleased_record_status', tmp_status, 'by_role', results)::text;
end $$;
