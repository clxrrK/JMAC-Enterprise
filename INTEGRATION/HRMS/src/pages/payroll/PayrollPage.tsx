import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { motion } from 'framer-motion'
import { Users2, TrendingUp, TrendingDown, Wallet, FileCheck, Plus, MoreHorizontal, PlayCircle, ShieldCheck, ClipboardList, AlertCircle } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { CreatePayrollPeriodDialog } from '@/components/payroll/CreatePayrollPeriodDialog'
import { AdjustPayrollRecordDialog } from '@/components/payroll/AdjustPayrollRecordDialog'
import { RejectPayrollDialog } from '@/components/payroll/RejectPayrollDialog'
import { PayrollDetailsSheet } from '@/components/payroll/PayrollDetailsSheet'
import {
  usePayrollPeriods,
  usePayrollRecords,
  usePayrollPeriodStats,
  useGeneratePayroll,
  useSubmitPayrollForApproval,
  useApprovePayrollRecord,
  useReleasePayroll,
  usePayrollRealtimeAlerts,
  type PayrollRecord,
} from '@/hooks/usePayroll'
import { useDepartments } from '@/hooks/useDepartments'
import { usePositions } from '@/hooks/usePositions'
import { useAuth } from '@/contexts/AuthContext'
import { canApproveWork, canPreparePayroll } from '@/lib/roles'
import { cn } from '@/lib/utils'
import { PAYROLL_STATUS_LABEL, PAYROLL_STATUS_VARIANT, PAYROLL_FREQUENCY_LABEL } from '@/lib/payrollLabels'
import { EMPLOYMENT_TYPE_LABEL, EMPLOYMENT_TYPE_SHORT_LABEL, EMPLOYMENT_TYPE_VARIANT } from '@/lib/jobPostingLabels'
import { formatMoney, type CurrencyCode } from '@/lib/currency'

const ALL = 'all'

function formatDate(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
}

function StatCard({
  label,
  value,
  icon: Icon,
  isLoading,
  index,
}: {
  label: string
  value: React.ReactNode
  icon: React.ComponentType<{ className?: string }>
  isLoading: boolean
  index: number
}) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: index * 0.05 }}>
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Icon className="h-4 w-4" />
          </div>
          {/* min-w-0 keeps the figure inside the card instead of widening it.
            * The grid below leaves room for one line up to ₱999,999,999.99;
            * anything longer wraps here rather than running into the next card. */}
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{label}</p>
            {isLoading ? <Skeleton className="mt-1 h-6 w-16" /> : <p className="font-display text-xl font-bold text-foreground [overflow-wrap:anywhere]">{value}</p>}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}

export default function PayrollPage() {
  usePayrollRealtimeAlerts()

  const { profile } = useAuth()
  const canApprove = canApproveWork(profile?.role)
  // Preparing and deciding are separate jobs — an HR Manager who could also
  // generate would be approving their own figures.
  const canPrepare = canPreparePayroll(profile?.role)
  const { data: periods, isLoading: periodsLoading } = usePayrollPeriods()
  const [selectedPeriodId, setSelectedPeriodId] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!selectedPeriodId && periods && periods.length > 0) {
      setSelectedPeriodId(periods[0].id)
    }
  }, [periods, selectedPeriodId])

  const selectedPeriod = periods?.find((p) => p.id === selectedPeriodId) ?? null

  const { data: records, isLoading: recordsLoading, isError } = usePayrollRecords(selectedPeriodId ?? undefined)
  const { data: stats, isLoading: statsLoading } = usePayrollPeriodStats(selectedPeriodId ?? undefined)
  const { data: departments } = useDepartments()
  const { data: positions } = usePositions()

  const generatePayroll = useGeneratePayroll()
  const submitPayroll = useSubmitPayrollForApproval()
  const approveRecord = useApprovePayrollRecord()
  const releasePayroll = useReleasePayroll()

  const [departmentFilter, setDepartmentFilter] = React.useState(ALL)
  const [positionFilter, setPositionFilter] = React.useState(ALL)
  const [employmentTypeFilter, setEmploymentTypeFilter] = React.useState(ALL)
  const [statusFilter, setStatusFilter] = React.useState(ALL)

  const [createDialogOpen, setCreateDialogOpen] = React.useState(false)
  const [adjustingRecord, setAdjustingRecord] = React.useState<PayrollRecord | null>(null)
  const [viewingRecordId, setViewingRecordId] = React.useState<string | null>(null)
  const [submitConfirmOpen, setSubmitConfirmOpen] = React.useState(false)
  const [rejectingRecord, setRejectingRecord] = React.useState<PayrollRecord | null>(null)
  const [releaseConfirmOpen, setReleaseConfirmOpen] = React.useState(false)

  const filteredPositions = React.useMemo(
    () => (departmentFilter === ALL ? positions : positions?.filter((p) => p.department_id === departmentFilter)),
    [positions, departmentFilter]
  )

  const pendingCount = records?.filter((r) => r.status === 'pending_approval').length ?? 0
  const rejectedCount = records?.filter((r) => r.status === 'rejected').length ?? 0
  const approvedCount = records?.filter((r) => r.status === 'approved' || r.status === 'released').length ?? 0
  const recordCount = records?.length ?? 0

  // Whose turn it is, in the words of whoever is reading it. The period status
  // is an aggregate of its records (see recompute_payroll_period_status), so
  // this is the one place that translates it into a next action.
  //
  // It also has to say when Finance gets the payroll, because nothing else on
  // the page does. Approving is per employee and is not the handoff: Finance
  // receives the payroll only when the HR Manager releases a fully approved
  // period. A manager who approved one of eight and saw nothing reach Finance
  // had no way to tell from here that seven decisions and a release remained.
  const workflowCopy = React.useMemo(() => {
    switch (selectedPeriod?.status) {
      case 'generated':
        return {
          title: 'Step 2 — Check the entries',
          detail: canPrepare
            ? 'Review the employee list, deductions, and totals, then submit them for HR Manager approval.'
            : 'HR Staff is still checking these figures. They come to you once submitted.',
        }
      case 'pending_approval':
        return {
          title: `Step 3 — Waiting on approval · ${approvedCount} of ${recordCount} employees approved`,
          detail: canApprove
            ? 'Approve or reject each employee individually from the row menu below. Finance receives this payroll only after every employee is approved and you release it.'
            : 'The HR Manager is reviewing these one employee at a time. Finance receives the payroll once every employee is approved and the HR Manager releases it.',
        }
      case 'rejected':
        return {
          title: `Step 2 — ${rejectedCount} ${rejectedCount === 1 ? 'record was' : 'records were'} sent back`,
          detail: canPrepare
            ? 'Each rejected row shows why. Adjust it, then submit the period again.'
            : 'HR Staff is correcting the records you rejected.',
        }
      case 'approved':
        return {
          title: 'Step 4 — Approved, ready to release',
          detail:
            'Releasing issues every payslip and hands the payroll to Finance for payment, in one step. Until then Finance has nothing to pay.',
        }
      case 'released':
        return {
          title: 'Complete — payslips released',
          detail: 'Employees can now see their payslip and net salary in My Payroll, and Finance has the payroll to disburse.',
        }
      default:
        return { title: 'Payroll not generated yet', detail: 'Generate payroll to compute this period.' }
    }
  }, [selectedPeriod?.status, canApprove, canPrepare, rejectedCount, approvedCount, recordCount])

  const rows = React.useMemo(() => {
    if (!records) return []
    return records.filter((r) => {
      if (departmentFilter !== ALL && r.employees.department_id !== departmentFilter) return false
      if (positionFilter !== ALL && r.employees.position_id !== positionFilter) return false
      if (employmentTypeFilter !== ALL && r.employees.employment_type !== employmentTypeFilter) return false
      if (statusFilter !== ALL && r.status !== statusFilter) return false
      return true
    })
  }, [records, departmentFilter, positionFilter, employmentTypeFilter, statusFilter])

  const columns: ColumnDef<PayrollRecord>[] = [
    {
      id: '_searchText',
      accessorFn: (row) => [row.employees.employee_number, row.employees.first_name, row.employees.last_name].filter(Boolean).join(' ').toLowerCase(),
      header: () => null,
      cell: () => null,
    },
    {
      id: 'name',
      header: 'Employee Name',
      accessorFn: (row) => `${row.employees.first_name} ${row.employees.last_name}`,
      cell: ({ row }) => (
        <div>
          <p className="font-medium text-foreground">
            {row.original.employees.first_name} {row.original.employees.last_name}
          </p>
          <p className="font-mono text-xs text-muted-foreground">{row.original.employees.employee_number}</p>
        </div>
      ),
    },
    {
      id: 'department',
      header: 'Department',
      accessorFn: (row) => row.employees.departments?.name ?? '',
      cell: ({ row }) => (row.original.employees.departments?.name ? <Badge variant="secondary">{row.original.employees.departments.name}</Badge> : '—'),
    },
    {
      id: 'employment_type',
      header: 'Type',
      accessorFn: (row) => row.employees.employment_type,
      // Worth seeing per row: a part-timer's rates come off a four-hour shift,
      // so their figures are meant to look different from everyone else's.
      cell: ({ row }) => (
        <Badge variant={EMPLOYMENT_TYPE_VARIANT[row.original.employees.employment_type]}>
          {EMPLOYMENT_TYPE_SHORT_LABEL[row.original.employees.employment_type]}
        </Badge>
      ),
    },
    {
      id: 'basic_salary',
      header: 'Basic Salary',
      accessorFn: (row) => row.basic_salary,
      cell: ({ row }) => formatMoney(Number(row.original.basic_salary), row.original.currency as CurrencyCode),
    },
    {
      id: 'gross_salary',
      header: 'Gross Salary',
      accessorFn: (row) => row.gross_salary,
      cell: ({ row }) => formatMoney(Number(row.original.gross_salary), row.original.currency as CurrencyCode),
    },
    {
      id: 'total_deductions',
      header: 'Deductions',
      accessorFn: (row) => row.total_deductions,
      cell: ({ row }) => formatMoney(Number(row.original.total_deductions), row.original.currency as CurrencyCode),
    },
    {
      id: 'net_salary',
      header: 'Net Salary',
      accessorFn: (row) => row.net_salary,
      cell: ({ row }) => <span className="font-medium text-foreground">{formatMoney(Number(row.original.net_salary), row.original.currency as CurrencyCode)}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5">
          <Badge variant={PAYROLL_STATUS_VARIANT[row.original.status]} className="w-fit">
            {PAYROLL_STATUS_LABEL[row.original.status]}
          </Badge>
          {/* A rejection is only useful if the reason travels with it, so it
            * sits on the row HR Staff has to fix rather than in a detail view. */}
          {row.original.status === 'rejected' && row.original.rejection_reason && (
            <span className="max-w-[16rem] text-xs text-muted-foreground">{row.original.rejection_reason}</span>
          )}
        </div>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const record = row.original
        // Approve and Reject are per-record on purpose — there is no
        // "approve all", because the review step exists so a manager looks at
        // each employee's figures.
        const isAwaitingDecision = record.status === 'pending_approval'
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => e.stopPropagation()}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setViewingRecordId(record.id)}>View</DropdownMenuItem>
              {canApprove && isAwaitingDecision && (
                <>
                  <DropdownMenuItem
                    onClick={() => approveRecord.mutate({ recordId: record.id, periodId: record.payroll_period_id })}
                  >
                    Approve
                  </DropdownMenuItem>
                  <DropdownMenuItem className="text-destructive" onClick={() => setRejectingRecord(record)}>
                    Reject
                  </DropdownMenuItem>
                </>
              )}
              {!canApprove && isAwaitingDecision && (
                <DropdownMenuItem disabled>Awaiting HR Manager</DropdownMenuItem>
              )}
              {canPrepare && record.status !== 'released' && record.status !== 'pending_approval' && (
                <DropdownMenuItem onClick={() => setAdjustingRecord(record)}>Adjust Payroll</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      },
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">Payroll Management</h2>
          <p className="text-sm text-muted-foreground">Compute, review, and release payroll for every employee.</p>
        </div>
        {canPrepare && (
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            New Payroll Period
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={selectedPeriodId ?? ''} onValueChange={setSelectedPeriodId}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder={periodsLoading ? 'Loading periods…' : 'Select a payroll period'} />
          </SelectTrigger>
          <SelectContent>
            {periods?.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {formatDate(p.period_start)} – {formatDate(p.period_end)} ({PAYROLL_FREQUENCY_LABEL[p.frequency]})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedPeriod && <Badge variant={PAYROLL_STATUS_VARIANT[selectedPeriod.status]}>{PAYROLL_STATUS_LABEL[selectedPeriod.status]}</Badge>}
      </div>

      {!selectedPeriod ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <p className="font-medium text-foreground">No payroll periods yet</p>
          <p className="text-sm text-muted-foreground">Create a payroll period to get started.</p>
        </div>
      ) : (
        <>
          {/* Columns follow the width this row actually gets -- a container
            * query, not a viewport breakpoint. The page sits beside a 16rem
            * sidebar and is capped at 72rem (max-w-6xl), so xl's six columns
            * left each card 150-182px, and ₱355,000.00 ran into its neighbour.
            *
            * A card needs 16rem: about 5.4rem of border, padding, icon and gap,
            * and 10.6rem for a figure as long as ₱999,999,999.99 in the display
            * face. So 2 columns from 2×16 + 0.75 = 32.75rem, 3 from 49.5rem, 6
            * from 99.75rem -- 1, 2, 3, 6 keeps the rows even. At this page's
            * width a large screen shows two rows of three. */}
          <div className="@container">
            <div className="grid grid-cols-1 gap-3 @min-[32.75rem]:grid-cols-2 @min-[49.5rem]:grid-cols-3 @min-[99.75rem]:grid-cols-6">
              <StatCard
                label="Payroll Period"
                value={
                  // Each date stays whole: a narrow card breaks between them,
                  // "Sep 1, 2026 –" over "Oct 31, 2026", never inside one.
                  <>
                    <span className="whitespace-nowrap">{formatDate(selectedPeriod.period_start)} –</span>{' '}
                    <span className="whitespace-nowrap">{formatDate(selectedPeriod.period_end)}</span>
                  </>
                }
                icon={Wallet}
                isLoading={false}
                index={0}
              />
              <StatCard label="Employees Included" value={String(stats?.employeesIncluded ?? 0)} icon={Users2} isLoading={statsLoading} index={1} />
              <StatCard label="Gross Payroll" value={formatMoney(stats?.grossPayroll ?? 0, 'PHP')} icon={TrendingUp} isLoading={statsLoading} index={2} />
              <StatCard label="Total Deductions" value={formatMoney(stats?.totalDeductions ?? 0, 'PHP')} icon={TrendingDown} isLoading={statsLoading} index={3} />
              <StatCard label="Total Net Payroll" value={formatMoney(stats?.totalNetPayroll ?? 0, 'PHP')} icon={Wallet} isLoading={statsLoading} index={4} />
              <StatCard label="Payslips Released" value={String(stats?.payslipsReleased ?? 0)} icon={FileCheck} isLoading={statsLoading} index={5} />
            </div>
          </div>

          {/* Workflow bar — where the period sits on
            * generated -> pending approval -> approved -> released, and whose
            * turn it is. Sits above the entries rather than in the table's
            * filter row, where it read as just another control. */}
          {records && records.length > 0 && (
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                      selectedPeriod.status === 'released'
                        ? 'bg-success/10 text-success'
                        : selectedPeriod.status === 'rejected'
                          ? 'bg-destructive/10 text-destructive'
                          : selectedPeriod.status === 'approved' || selectedPeriod.status === 'pending_approval'
                            ? 'bg-warning/10 text-warning'
                            : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {selectedPeriod.status === 'released' ? (
                      <FileCheck className="h-4 w-4" />
                    ) : selectedPeriod.status === 'rejected' ? (
                      <AlertCircle className="h-4 w-4" />
                    ) : selectedPeriod.status === 'approved' ? (
                      <ShieldCheck className="h-4 w-4" />
                    ) : (
                      <ClipboardList className="h-4 w-4" />
                    )}
                  </div>
                  <div>
                    <p className="font-medium text-foreground">{workflowCopy.title}</p>
                    <p className="text-sm text-muted-foreground">{workflowCopy.detail}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Submitting is the one batch step left: it isn't a
                    * decision, just HR Staff saying they've finished checking. */}
                  {(selectedPeriod.status === 'generated' || selectedPeriod.status === 'rejected') &&
                    (canPrepare ? (
                      <Button loading={submitPayroll.isPending} onClick={() => setSubmitConfirmOpen(true)}>
                        <ClipboardList className="h-4 w-4" />
                        Submit for Approval
                      </Button>
                    ) : (
                      <Badge variant="muted">Waiting for HR Staff to submit</Badge>
                    ))}
                  {selectedPeriod.status === 'pending_approval' && (
                    <Badge variant="warning">
                      {canApprove ? `${pendingCount} awaiting your decision` : 'Waiting for HR Manager approval'}
                    </Badge>
                  )}
                  {selectedPeriod.status === 'approved' &&
                    (canApprove ? (
                      <Button loading={releasePayroll.isPending} onClick={() => setReleaseConfirmOpen(true)}>
                        <FileCheck className="h-4 w-4" />
                        Release Payslips
                      </Button>
                    ) : (
                      <Badge variant="warning">Approved — waiting for HR Manager to release</Badge>
                    ))}
                  {selectedPeriod.status === 'released' && <Badge variant="success">Released</Badge>}
                </div>
              </CardContent>
            </Card>
          )}

          {records && records.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
              <p className="font-medium text-foreground">Payroll hasn't been generated for this period yet</p>
              <p className="text-sm text-muted-foreground">
                {canPrepare
                  ? 'Employee records, attendance, and leave will be retrieved automatically.'
                  : 'HR Staff generates payroll. It arrives here for your review once they submit it.'}
              </p>
              {canPrepare && (
                <Button loading={generatePayroll.isPending} onClick={() => generatePayroll.mutate({ periodId: selectedPeriod.id })}>
                  <PlayCircle className="h-4 w-4" />
                  Generate Payroll
                </Button>
              )}
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
              <p className="font-medium text-foreground">Couldn't load payroll records</p>
              <p className="text-sm text-muted-foreground">Please refresh the page or try again shortly.</p>
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={rows}
              isLoading={recordsLoading}
              density="compact"
              searchPlaceholder="Search by name, employee ID, or department..."
              searchColumn="_searchText"
              emptyTitle="No payroll records match these filters"
              toolbarAction={
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={departmentFilter} onValueChange={(v) => { setDepartmentFilter(v); setPositionFilter(ALL) }}>
                    <SelectTrigger className="w-36">
                      <SelectValue placeholder="Department" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>All departments</SelectItem>
                      {departments?.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={positionFilter} onValueChange={setPositionFilter}>
                    <SelectTrigger className="w-36">
                      <SelectValue placeholder="Position" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>All positions</SelectItem>
                      {filteredPositions?.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={employmentTypeFilter} onValueChange={setEmploymentTypeFilter}>
                    <SelectTrigger className="w-36">
                      <SelectValue placeholder="Employment Type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>All types</SelectItem>
                      {Object.entries(EMPLOYMENT_TYPE_LABEL).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-36">
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>All statuses</SelectItem>
                      {(Object.entries(PAYROLL_STATUS_LABEL) as [keyof typeof PAYROLL_STATUS_LABEL, string][]).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              }
            />
          )}
        </>
      )}

      <CreatePayrollPeriodDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} onCreated={setSelectedPeriodId} />
      <AdjustPayrollRecordDialog open={!!adjustingRecord} onOpenChange={(open) => !open && setAdjustingRecord(null)} record={adjustingRecord} />
      <PayrollDetailsSheet recordId={viewingRecordId} open={!!viewingRecordId} onOpenChange={(open) => !open && setViewingRecordId(null)} />

      <RejectPayrollDialog
        record={rejectingRecord}
        open={!!rejectingRecord}
        onOpenChange={(open) => !open && setRejectingRecord(null)}
      />

      <AlertDialog open={submitConfirmOpen} onOpenChange={setSubmitConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit this payroll for approval?</AlertDialogTitle>
            <AlertDialogDescription>
              This hands {stats?.employeesIncluded ?? 0} employee {(stats?.employeesIncluded ?? 0) === 1 ? 'record' : 'records'} to
              the HR Manager, who approves or rejects each one individually. You can still adjust a record after it comes
              back — adjusting it returns that employee to your side of the workflow.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (selectedPeriod) submitPayroll.mutate({ periodId: selectedPeriod.id })
                setSubmitConfirmOpen(false)
              }}
            >
              Submit for Approval
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={releaseConfirmOpen} onOpenChange={setReleaseConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Release this payroll?</AlertDialogTitle>
            <AlertDialogDescription>
              This issues a payslip for every employee in this period and hands the payroll to Finance for payment, in one step. Released payroll records become read-only and appear in each employee’s My Payroll.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (selectedPeriod) releasePayroll.mutate({ periodId: selectedPeriod.id })
                setReleaseConfirmOpen(false)
              }}
            >
              Release Payroll
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
