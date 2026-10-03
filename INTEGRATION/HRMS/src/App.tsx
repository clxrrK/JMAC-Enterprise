import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from '@/contexts/AuthContext'
import { ProtectedRoute } from '@/components/ProtectedRoute'
import { PortalRedirect } from '@/components/PortalRedirect'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { PosLayout } from '@/components/layout/PosLayout'
import { PublicLayout } from '@/layouts/PublicLayout'
import { Toaster } from '@/components/ui/sonner'
import LoginPage from '@/pages/LoginPage'
import SetupPasswordPage from '@/pages/auth/SetupPasswordPage'
import ForgotPasswordPage from '@/pages/auth/ForgotPasswordPage'
import ResetPasswordPage from '@/pages/auth/ResetPasswordPage'
import DashboardHome from '@/pages/DashboardHome'
import DepartmentsPage from '@/pages/admin/DepartmentsPage'
import PositionsPage from '@/pages/admin/PositionsPage'
import SalaryGradesPage from '@/pages/admin/SalaryGradesPage'
import SettingsPage from '@/pages/admin/SettingsPage'
import HrAccountsPage from '@/pages/admin/HrAccountsPage'
import JobPostingsPage from '@/pages/recruitment/JobPostingsPage'
import RecruitmentPage from '@/pages/recruitment/RecruitmentPage'
import InterviewsPage from '@/pages/interviews/InterviewsPage'
import DeploymentPage from '@/pages/deployment/DeploymentPage'
import ContractPrintPage from '@/pages/deployment/ContractPrintPage'
import EmployeesPage from '@/pages/employees/EmployeesPage'
import CreateEmployeePage from '@/pages/employees/CreateEmployeePage'
import EmployeeDetailsPage from '@/pages/employees/EmployeeDetailsPage'
import AttendancePage from '@/pages/attendance/AttendancePage'
import WorkSchedulesPage from '@/pages/admin/WorkSchedulesPage'
import BranchesPage from '@/pages/admin/BranchesPage'
import PosAccessPage from '@/pages/admin/PosAccessPage'
import PosSettingsPage from '@/pages/admin/PosSettingsPage'
import PosProductsPage from '@/pages/admin/PosProductsPage'
import AdminPosCategoriesPage from '@/pages/admin/PosCategoriesPage'
import PosAuditLogsPage from '@/pages/pos/PosAuditLogsPage'
import PosRequestsPage from '@/pages/pos/PosRequestsPage'
import PosCategoriesPage from '@/pages/pos/PosCategoriesPage'
import PosDashboardPage from '@/pages/pos/PosDashboardPage'
import PosStockPage from '@/pages/pos/PosStockPage'
import PosBranchProductsPage from '@/pages/pos/PosProductsPage'
import PosBranchSettingsPage from '@/pages/pos/PosSettingsPage'
import FinanceHomePage from '@/pages/fms/FinanceHomePage'
import SupplierInvoicesPage from '@/pages/fms/SupplierInvoicesPage'
import BudgetsPage from '@/pages/fms/BudgetsPage'
import FinanceRequestsPage from '@/pages/fms/FinanceRequestsPage'
import ProcurementPage from '@/pages/fms/ProcurementPage'
import FinanceSalesPage from '@/pages/fms/FinanceSalesPage'
import SettlementsPage from '@/pages/fms/SettlementsPage'
import ReimbursementsPage from '@/pages/fms/ReimbursementsPage'
import PayrollFinancePage from '@/pages/fms/PayrollFinancePage'
import TreasuryPage from '@/pages/fms/TreasuryPage'
import PosDeliveriesPage from '@/pages/pos/PosDeliveriesPage'
import MyRequestsPage from '@/pages/employee-portal/MyRequestsPage'
import VendorsPage from '@/pages/fms/VendorsPage'
import FinanceCategoriesPage from '@/pages/fms/FinanceCategoriesPage'
import FinanceAccountsPage from '@/pages/fms/FinanceAccountsPage'
import JournalEntriesPage from '@/pages/fms/JournalEntriesPage'
import GeneralLedgerPage from '@/pages/fms/GeneralLedgerPage'
import TrialBalancePage from '@/pages/fms/TrialBalancePage'
import AccountingReportsPage from '@/pages/fms/AccountingReportsPage'
import { FinanceModuleRoute } from '@/components/fms/FinanceModuleRoute'
import PosTillPage from '@/pages/pos/PosTillPage'
import PosTransactionsPage from '@/pages/pos/PosTransactionsPage'
import AdminPosTransactionsPage from '@/pages/admin/PosTransactionsPage'
import AdminPosAuditLogsPage from '@/pages/admin/PosAuditLogsPage'
import AdminPosRequestsPage from '@/pages/admin/PosRequestsPage'
import { PosIndexRedirect } from '@/components/pos/PosIndexRedirect'
import { PosManagerRoute } from '@/components/pos/PosManagerRoute'
import PosReportsPage from '@/pages/pos/PosReportsPage'
import AdminPosReportsPage from '@/pages/admin/AdminPosReportsPage'
import PosInventoryPage from '@/pages/admin/PosInventoryPage'
import LeavePage from '@/pages/leave/LeavePage'
import PayrollPage from '@/pages/payroll/PayrollPage'
import PayslipPrintPage, { MyPayslipPage } from '@/pages/payroll/PayslipPrintPage'
import ReportsPage from '@/pages/reports/ReportsPage'
import GenerateReportPage from '@/pages/reports/GenerateReportPage'
import ReportPrintPage from '@/pages/reports/ReportPrintPage'
import EmployeeDashboard from '@/pages/employee-portal/EmployeeDashboard'
import MyAttendancePage from '@/pages/employee-portal/MyAttendancePage'
import MyLeavePage from '@/pages/employee-portal/MyLeavePage'
import MyPayrollPage from '@/pages/employee-portal/MyPayrollPage'
import HomePage from '@/pages/public/HomePage'
import CareersPage from '@/pages/public/CareersPage'
import CareerDetailsPage from '@/pages/public/CareerDetailsPage'
import ApplyPage from '@/pages/public/ApplyPage'
import ApplicationSuccessPage from '@/pages/public/ApplicationSuccessPage'
import TrackApplicationPage from '@/pages/public/TrackApplicationPage'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <AuthProvider>
          <Routes>
            <Route element={<PublicLayout />}>
              <Route index element={<HomePage />} />
              <Route path="careers" element={<CareersPage />} />
              <Route path="careers/application-success" element={<ApplicationSuccessPage />} />
              <Route path="track" element={<TrackApplicationPage />} />
              <Route path="careers/:jobId" element={<CareerDetailsPage />} />
              <Route path="careers/:jobId/apply" element={<ApplyPage />} />
            </Route>

            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth/setup-password" element={<SetupPasswordPage />} />
            {/* Recovery is Supabase's: the link becomes a session before the
                page renders, so there is no home-grown token to validate. The
                path is shared with the sender via RESET_PASSWORD_PATH. */}
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/auth/reset-password" element={<ResetPasswordPage />} />

            {/* Every sign-in lands here first. It decides the portal from the
                account that just authenticated -- see PortalRedirect. */}
            <Route
              path="/home"
              element={
                <ProtectedRoute>
                  <PortalRedirect />
                </ProtectedRoute>
              }
            />

            {/* The POS portal: the operational workspace for POS Managers and
                Cashiers. A sibling of /dashboard, not a child -- its own layout,
                its own sidebar, and access from pos_branch_assignments rather
                than from the HR role.

                Administrators are turned away on purpose. HRMS/JMAC is the
                parent system and its administrator belongs in it; dropping them
                into this layout would hide every HR module from the person
                responsible for them. Their POS modules -- including the till
                itself, the same PosTillPage rendered at
                /dashboard/admin/pos -- live in the back office instead. */}
            {/* Finance.

                requireFinance rather than a role list, so the guard asks the
                same question the database does -- an active grant, not a role
                somebody's profile happens to claim.

                Administrators are admitted. They were blocked here originally,
                on the reasoning that they are not one of the three operational
                finance roles -- still true, and still the reason they get no
                buttons. But the person answerable for the whole system has to
                be able to look at the part of it that handles money, and being
                unable to open the ledger is a blind spot rather than a
                separation of duties. What they may DO is unchanged: every
                finance write is gated on has_finance_privilege(), which an
                'admin' profile can never satisfy. */}
            <Route
              path="/fms"
              element={
                <ProtectedRoute requireFinance>
                  <DashboardLayout />
                </ProtectedRoute>
              }
            >
              {/* Every page below is wrapped in FinanceModuleRoute, which asks
                  the same FINANCE_MODULES table the sidebar builds itself from.
                  A role whose workspace does not contain a module is refused
                  its URL too, so hiding a link is never the only thing in the
                  way. The database is still the authority; this only decides
                  what is worth rendering. */}
              <Route index element={<FinanceHomePage />} />
              <Route
                path="requests"
                element={
                  <FinanceModuleRoute route="/fms/requests">
                    <FinanceRequestsPage />
                  </FinanceModuleRoute>
                }
              />
              <Route
                path="procurement"
                element={
                  <FinanceModuleRoute route="/fms/procurement">
                    <ProcurementPage />
                  </FinanceModuleRoute>
                }
              />
              {/* Supplier invoices and what is owed on them. One route:
                  an account payable is an approved invoice nobody has
                  paid, not a separate document. */}
              <Route
                path="invoices"
                element={
                  <FinanceModuleRoute route="/fms/invoices">
                    <SupplierInvoicesPage />
                  </FinanceModuleRoute>
                }
              />
              {/* Read-only. POS owns every sale behind this page, and a
                  correction has to start where the transaction did. */}
              <Route
                path="sales"
                element={
                  <FinanceModuleRoute route="/fms/sales">
                    <FinanceSalesPage />
                  </FinanceModuleRoute>
                }
              />
              {/* Collections arriving in a company account, and the accounts
                  themselves. Supplier payments live on the invoice they settle
                  rather than on a page of their own. */}
              <Route
                path="settlements"
                element={
                  <FinanceModuleRoute route="/fms/settlements">
                    <SettlementsPage />
                  </FinanceModuleRoute>
                }
              />
              <Route
                path="treasury"
                element={
                  <FinanceModuleRoute route="/fms/treasury">
                    <TreasuryPage />
                  </FinanceModuleRoute>
                }
              />
              {/* Employee expense claims, and paying finalized payroll. Both
                  settle a payable; neither calculates one. */}
              <Route
                path="reimbursements"
                element={
                  <FinanceModuleRoute route="/fms/reimbursements">
                    <ReimbursementsPage />
                  </FinanceModuleRoute>
                }
              />
              <Route
                path="payroll"
                element={
                  <FinanceModuleRoute route="/fms/payroll">
                    <PayrollFinancePage />
                  </FinanceModuleRoute>
                }
              />
              <Route
                path="budgets"
                element={
                  <FinanceModuleRoute route="/fms/budgets">
                    <BudgetsPage />
                  </FinanceModuleRoute>
                }
              />
              <Route
                path="vendors"
                element={
                  <FinanceModuleRoute route="/fms/vendors">
                    <VendorsPage />
                  </FinanceModuleRoute>
                }
              />
              <Route
                path="categories"
                element={
                  <FinanceModuleRoute route="/fms/categories">
                    <FinanceCategoriesPage />
                  </FinanceModuleRoute>
                }
              />
              <Route
                path="accounts"
                element={
                  <FinanceModuleRoute route="/fms/accounts">
                    <FinanceAccountsPage />
                  </FinanceModuleRoute>
                }
              />
              {/* Accounting. Read-only by construction: these pages record
                  what the routes above already did, and none of them can
                  create, edit or approve an entry. */}
              <Route
                path="journal"
                element={
                  <FinanceModuleRoute route="/fms/journal">
                    <JournalEntriesPage />
                  </FinanceModuleRoute>
                }
              />
              <Route
                path="ledger"
                element={
                  <FinanceModuleRoute route="/fms/ledger">
                    <GeneralLedgerPage />
                  </FinanceModuleRoute>
                }
              />
              <Route
                path="trial-balance"
                element={
                  <FinanceModuleRoute route="/fms/trial-balance">
                    <TrialBalancePage />
                  </FinanceModuleRoute>
                }
              />
              <Route
                path="reports"
                element={
                  <FinanceModuleRoute route="/fms/reports">
                    <AccountingReportsPage />
                  </FinanceModuleRoute>
                }
              />
            </Route>

            <Route
              path="/pos"
              element={
                <ProtectedRoute requirePos blockRoles={['admin']}>
                  <PosLayout />
                </ProtectedRoute>
              }
            >
              {/* Role-aware landing, decided in one place. A cashier opens
                  the app to sell; a manager opens it to see how the branch is
                  doing. (The Overview placeholder that used to sit here
                  described the portal instead of doing anything.) */}
              <Route index element={<PosIndexRedirect />} />
              {/* The branch's operational dashboard. Manager-only, and gated in
                  the database per branch -- the RPCs behind it check
                  has_pos_role(branch, ['manager']) and declare no cost column. */}
              <Route path="dashboard" element={<PosDashboardPage />} />
              {/* The enterprise taxonomy, with this branch's own counts against
                  it. Manager-only at the route now: it was reachable by a
                  Cashier who typed the URL, who then saw an empty state because
                  get_branch_category_summary returns them nothing. An empty
                  page is not a refusal, and Categories is management.

                  Categories are GLOBAL -- pos_product_categories has no
                  branch_id. A manager may create and rename, which is what
                  create_pos_category and rename_pos_category authorise; RLS on
                  the table itself stays is_admin(), so reordering, archiving
                  and deleting remain the Administrator's. */}
              <Route
                path="categories"
                element={
                  <PosManagerRoute>
                    <PosCategoriesPage />
                  </PosManagerRoute>
                }
              />
              {/* The branch's own catalogue. Read-only for a cashier; a POS
                  Manager may pause or resume what their branch carries. Neither
                  can reach the product master -- RLS on pos_products is
                  is_admin(), and this page reads RPCs that omit cost. */}
              {/* The till. Everything it shows is a preview -- checkout_pos_sale
                  recomputes price, fees, total and change under lock, and its
                  answer is what is charged. */}
              <Route path="till" element={<PosTillPage />} />
              {/* Catalogue was the manager's branch product surface. Its one
                  real capability -- stop or resume offering a product -- moved
                  onto Inventory, which already lists the same products. The
                  redirect keeps old links working instead of leaving a second
                  screen doing half the same job. */}
              <Route path="catalogue" element={<Navigate to="/pos/stock" replace />} />
              <Route path="transactions" element={<PosTransactionsPage />} />
              <Route
                path="reports"
                element={
                  <PosManagerRoute>
                    <PosReportsPage />
                  </PosManagerRoute>
                }
              />
              {/* What changed at this branch, and who changed it. Manager-only
                  at the route, and again in the database: the RPC filters on
                  manager_visible and checks an active Manager assignment for
                  the branch asked about. */}
              <Route
                path="audit-logs"
                element={
                  <PosManagerRoute>
                    <PosAuditLogsPage />
                  </PosManagerRoute>
                }
              />
              {/* Stock levels and the low-stock level, for the branch's POS
                  Manager. Receiving and adjusting stay with an Administrator in
                  this phase, so nothing here creates inventory. */}
              <Route path="stock" element={<PosStockPage />} />
              {/* Deliveries against approved purchase orders. Manager-gated:
                  confirming one is what moves stock, and the server refuses
                  anybody who is not the destination branch's manager. */}
              <Route
                path="deliveries"
                element={
                  <PosManagerRoute>
                    <PosDeliveriesPage />
                  </PosManagerRoute>
                }
              />
              {/* The branch's selling catalogue. Manager-gated: the page's data
                  comes from manager-scoped RPCs and the only write it offers is
                  is_available, which a trigger confines to the manager's own
                  branch. */}
              <Route
                path="products"
                element={
                  <PosManagerRoute>
                    <PosBranchProductsPage />
                  </PosManagerRoute>
                }
              />
              {/* What the till charges, read-only. Customer pricing stays with
                  an Administrator, as it does for product prices. */}
              <Route
                path="settings"
                element={
                  <PosManagerRoute>
                    <PosBranchSettingsPage />
                  </PosManagerRoute>
                }
              />
              {/* The other half of Inventory: what this branch has asked the
                  business for. A request moves no stock, and neither does
                  approving one -- quantity changes only through receiving. */}
              <Route
                path="requests"
                element={
                  <PosManagerRoute>
                    <PosRequestsPage />
                  </PosManagerRoute>
                }
              />
            </Route>

            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <DashboardLayout />
                </ProtectedRoute>
              }
            >
              <Route
                index
                element={
                  <ProtectedRoute requireBackOffice>
                    <DashboardHome />
                  </ProtectedRoute>
                }
              />

              {/* Internal HR back-office — employee-role logins are blocked from
                  all of it and land on DashboardHome's placeholder instead. */}
              {/* Job Posting and Recruitment are each one role's own work (see
                * canAccessModule in lib/roles.ts), so the other role is kept out
                * of the route as well as off the sidebar. */}
              <Route
                path="job-postings"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_staff']}>
                    <JobPostingsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="recruitment"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager']}>
                    <RecruitmentPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="interviews"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <InterviewsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="deployment"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <DeploymentPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="deployment/:applicationId/contract"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <ContractPrintPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employees"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <EmployeesPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employees/new"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <CreateEmployeePage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employees/:employeeId"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <EmployeeDetailsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="attendance"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <AttendancePage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="leave"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <LeavePage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="payroll"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <PayrollPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="payroll/:recordId/payslip"
                element={
                  // HR's view of an employee's payslip, opened from Payroll.
                  // Employees used to be let in here to read their own, which
                  // put them inside Human Resources -- the shell follows the
                  // address. Their own payslip has its own address in My
                  // Workspace now (my-payroll/:recordId/payslip).
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <PayslipPrintPage />
                  </ProtectedRoute>
                }
              />

              <Route
                path="reports"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <ReportsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="reports/new"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <GenerateReportPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="reports/print"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <ReportPrintPage />
                  </ProtectedRoute>
                }
              />

              {/* Self-service starts here rather than at /dashboard, which is
                  the HR dashboard for anyone who also works in HR. */}
              <Route
                path="my-dashboard"
                element={
                  <ProtectedRoute requireEmployee>
                    <EmployeeDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="my-attendance"
                element={
                  <ProtectedRoute requireEmployee>
                    <MyAttendancePage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="my-leave"
                element={
                  <ProtectedRoute requireEmployee>
                    <MyLeavePage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="my-payroll"
                element={
                  <ProtectedRoute requireEmployee>
                    <MyPayrollPage />
                  </ProtectedRoute>
                }
              />
              {/* Your own payslip, without leaving My Workspace -- on a refresh
                  or a pasted link too, since the shell is chosen from the
                  address. Gated on employment like the rest of self-service, so
                  an Accountant or an HR Manager opens theirs here as well. The
                  page asks for the signed-in person's own released record, and
                  RLS refuses anyone else's for everyone but HR. */}
              <Route
                path="my-payroll/:recordId/payslip"
                element={
                  <ProtectedRoute requireEmployee>
                    <MyPayslipPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="my-requests"
                element={
                  <ProtectedRoute requireEmployee>
                    <MyRequestsPage />
                  </ProtectedRoute>
                }
              />

              <Route
                path="admin/accounts"
                element={
                  <ProtectedRoute allowedRoles={['admin']}>
                    <HrAccountsPage />
                  </ProtectedRoute>
                }
              />
              {/* Reference-data modules are shared: HR Staff prepares changes
                  (which become change requests), HR Manager reviews and applies
                  them, and salary grades are manager-controlled
                  outright. Per-action authority is enforced in RLS, not here. */}
              <Route
                path="admin/departments"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <DepartmentsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/positions"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <PositionsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/salary-grades"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager']}>
                    <SalaryGradesPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/settings"
                element={
                  <ProtectedRoute allowedRoles={['admin']}>
                    <SettingsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/work-schedules"
                element={
                  <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
                    <WorkSchedulesPage />
                  </ProtectedRoute>
                }
              />

              {/* The general Approvals screen is gone from navigation. It
                  existed for HR Staff to propose reference-data changes for an
                  HR Manager to approve, and HR Staff no longer edits reference
                  data at all -- the queue has no producer. change_requests, its
                  RLS and every historical row are deliberately left in place. */}
              <Route
                path="admin/branches"
                element={
                  <ProtectedRoute allowedRoles={['admin']}>
                    <BranchesPage />
                  </ProtectedRoute>
                }
              />
              {/* The selling screen, inside the back office. Deliberately the
                  same PosTillPage a cashier uses and the same
                  checkout_pos_sale behind it -- an Administrator who needs to
                  ring something up should not be running a second
                  implementation of checkout. */}
              <Route
                path="admin/pos"
                element={
                  <ProtectedRoute allowedRoles={['admin']}>
                    <PosTillPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/pos-transactions"
                element={
                  <ProtectedRoute allowedRoles={['admin']}>
                    <AdminPosTransactionsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/pos-reports"
                element={
                  <ProtectedRoute allowedRoles={['admin']}>
                    <AdminPosReportsPage />
                  </ProtectedRoute>
                }
              />
              {/* Deciding who may work a till is account administration, so it
                  sits with HR Accounts and Branches rather than in the POS
                  portal -- a POS Manager runs a branch, they do not hand out
                  access to it. RLS says the same thing independently:
                  pos_branch_assignments is is_admin() on both sides. */}
              <Route
                path="admin/pos-access"
                element={
                  <ProtectedRoute allowedRoles={['admin']}>
                    <PosAccessPage />
                  </ProtectedRoute>
                }
              />
              {/* What a branch's till charges and shows. Administrator-only for
                  the same reason as POS Access: a POS Manager trades at a
                  branch, they do not decide its fees. branch_pos_settings
                  enforces it in RLS regardless of this guard. */}
              {/* The POS audit log for the Administrator: branch operations,
                  POS access administration and enterprise catalogue changes,
                  in the back office rather than the POS portal. */}
              {/* The POS request review queue. Carry requests are permanently
                  reviewed here -- they are catalogue decisions. Restock demand
                  is reviewed here only until FMS owns procurement. */}
              <Route
                path="admin/pos-requests"
                element={
                  <ProtectedRoute allowedRoles={['admin']}>
                    <AdminPosRequestsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/pos-audit-logs"
                element={
                  <ProtectedRoute allowedRoles={['admin']}>
                    <AdminPosAuditLogsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/pos-settings"
                element={
                  <ProtectedRoute allowedRoles={['admin']}>
                    <PosSettingsPage />
                  </ProtectedRoute>
                }
              />
              {/* The product master and its taxonomy are enterprise product
                  administration, so both are Administrator-only. A POS Manager
                  proposes products through a request workflow in a later phase
                  rather than creating them here. */}
              <Route
                path="admin/pos-products"
                element={
                  <ProtectedRoute allowedRoles={['admin']}>
                    <PosProductsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/pos-categories"
                element={
                  <ProtectedRoute allowedRoles={['admin']}>
                    <AdminPosCategoriesPage />
                  </ProtectedRoute>
                }
              />
              {/* Receiving and adjusting stock, and the only screen that shows
                  what a branch's stock cost it. Administrator-only: a POS
                  Manager requests stock rather than creating it. */}
              <Route
                path="admin/pos-inventory"
                element={
                  <ProtectedRoute allowedRoles={['admin']}>
                    <PosInventoryPage />
                  </ProtectedRoute>
                }
              />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <Toaster />
        </AuthProvider>
      </Router>
    </QueryClientProvider>
  )
}
