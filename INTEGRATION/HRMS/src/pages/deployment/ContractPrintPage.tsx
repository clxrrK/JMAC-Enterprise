import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useSystemSettings } from '@/hooks/useSystemSettings'
import { useDeploymentApplicationDetail, getLatestOffer, getLatestContract } from '@/hooks/useDeployment'
import { EMPLOYMENT_TYPE_LABEL } from '@/lib/jobPostingLabels'
import { formatMoney, type CurrencyCode } from '@/lib/currency'
import { resolveSubmittedApplicant } from '@/lib/hiring'

function formatDate(value: string | null) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
}

export default function ContractPrintPage() {
  const { applicationId } = useParams<{ applicationId: string }>()
  const { data: application, isLoading } = useDeploymentApplicationDetail(applicationId)
  const { data: settings } = useSystemSettings()

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="mt-6 h-96 w-full" />
      </div>
    )
  }

  const offer = application ? getLatestOffer(application) : null
  const contract = offer ? getLatestContract(offer) : null

  if (!application || !offer || !contract) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 px-6 py-24 text-center">
        <h1 className="font-display text-2xl font-bold text-foreground">Contract not available</h1>
        <p className="text-muted-foreground">This applicant doesn't have a prepared employment contract yet.</p>
        <Button asChild variant="outline">
          <Link to="/dashboard/deployment">
            <ArrowLeft className="h-4 w-4" />
            Back to Deployment
          </Link>
        </Button>
      </div>
    )
  }

  const applicant = resolveSubmittedApplicant(application, application.applicants)
  const jobPosting = application.job_postings
  const companyName = settings?.company_name || 'JMAC Enterprise'

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 print:p-0">
      <div className="mb-6 flex items-center justify-between print:hidden">
        <Button asChild variant="outline" size="sm">
          <Link to="/dashboard/deployment">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <Button size="sm" onClick={() => window.print()}>
          <Printer className="h-4 w-4" />
          Print / Save as PDF
        </Button>
      </div>

      {/* contract-document: printed on A4 portrait (the @page rule in index.css),
        * whose margins replace the card's padding so every sheet matches. */}
      <article className="contract-document flex flex-col gap-8 rounded-xl border border-border bg-card p-10 shadow-sm print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <header className="flex flex-col items-center gap-1 border-b border-border pb-6 text-center">
          <h1 className="font-display text-2xl font-bold text-foreground">{companyName}</h1>
          <p className="text-sm font-medium uppercase tracking-widest text-foreground">Contract of Employment</p>
          <p className="text-xs text-muted-foreground">
            Reference: {application.reference_code} · Issued {formatDate(new Date().toISOString().slice(0, 10))}
          </p>
        </header>

        <section className="text-sm leading-relaxed text-foreground">
          <p>
            This Contract of Employment is entered into on{' '}
            <strong>{formatDate(contract.start_date ?? offer.start_date)}</strong> by and between{' '}
            <strong>{companyName}</strong>, a company duly organized and existing under the laws of the Republic of the
            Philippines (hereinafter referred to as the &ldquo;Company&rdquo;), and{' '}
            <strong>
              {applicant?.first_name} {applicant?.last_name}
            </strong>
            , of legal age, with address at {applicant?.address ?? '—'} (hereinafter referred to as the
            &ldquo;Employee&rdquo;).
          </p>
          <p className="mt-3">
            <strong>WITNESSETH:</strong> That the parties, intending to be legally bound, hereby agree to the following
            terms and conditions of employment.
          </p>
        </section>

        <section className="grid grid-cols-2 gap-4 text-sm print:break-inside-avoid">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Employee Name</p>
            <p className="text-foreground">
              {applicant?.first_name} {applicant?.last_name}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email</p>
            <p className="text-foreground">{applicant?.email ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Address</p>
            <p className="text-foreground">{applicant?.address ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Phone</p>
            <p className="text-foreground">{applicant?.phone ?? '—'}</p>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-4 text-sm print:break-inside-avoid">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Position</p>
            <p className="text-foreground">{jobPosting?.positions?.title ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Department</p>
            <p className="text-foreground">{jobPosting?.departments?.name ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Employment Type</p>
            <p className="text-foreground">{EMPLOYMENT_TYPE_LABEL[offer.employment_type]}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Salary</p>
            <p className="text-foreground">{formatMoney(offer.proposed_salary, offer.currency as CurrencyCode)}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Start Date</p>
            <p className="text-foreground">{formatDate(contract.start_date ?? offer.start_date)}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Working Hours</p>
            <p className="text-foreground">{offer.working_hours ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Working Days</p>
            <p className="text-foreground">{offer.working_days ?? '—'}</p>
          </div>
        </section>

        {offer.additional_compensation && (
          <section className="flex flex-col gap-2 text-sm print:break-inside-avoid">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Additional Compensation</p>
            <p className="whitespace-pre-line text-foreground">{offer.additional_compensation}</p>
          </section>
        )}

        {/* Page 2 — terms. break-before-page keeps each part on its own sheet
          * when printed, so the contract reads as a real multi-page document. */}
        {contract.terms && (
          <section className="flex flex-col gap-3 text-sm print:break-before-page">
            <h2 className="font-display text-lg font-bold text-foreground print:break-after-avoid">Terms &amp; Conditions of Employment</h2>
            <p className="whitespace-pre-line leading-relaxed text-foreground">{contract.terms}</p>
          </section>
        )}

        {/* Page 3 — annexed company policies. */}
        {contract.company_policies && (
          <section className="flex flex-col gap-3 text-sm print:break-before-page">
            <h2 className="font-display text-lg font-bold text-foreground print:break-after-avoid">Annex A — Company Policies</h2>
            <p className="whitespace-pre-line leading-relaxed text-foreground">{contract.company_policies}</p>
          </section>
        )}

        {contract.additional_notes && (
          <section className="flex flex-col gap-2 text-sm">
            <h2 className="font-display text-base font-bold text-foreground print:break-after-avoid">Additional Provisions</h2>
            <p className="whitespace-pre-line leading-relaxed text-foreground">{contract.additional_notes}</p>
          </section>
        )}

        <section className="flex flex-col gap-3 border-t border-border pt-6 text-sm print:break-inside-avoid">
          <h2 className="font-display text-base font-bold text-foreground">Acknowledgement</h2>
          <p className="leading-relaxed text-foreground">
            The Employee acknowledges having read and understood this Contract in its entirety, including the Company
            Policies annexed hereto, and voluntarily accepts employment under the terms stated. The Employee further
            confirms that all information provided during the application process is true and correct, and understands
            that any misrepresentation may be a ground for termination.
          </p>
          <p className="leading-relaxed text-foreground">
            <strong>IN WITNESS WHEREOF,</strong> the parties have signed this Contract on the dates indicated below.
          </p>
        </section>

        {/* Never a page break between "IN WITNESS WHEREOF" and the signature
          * lines: a signature page with no text above it is no contract page. */}
        <section className="mt-8 grid grid-cols-2 gap-10 text-sm print:break-before-avoid print:break-inside-avoid">
          <div className="flex flex-col gap-8">
            <div className="border-b border-foreground/40 pb-1" />
            <div>
              <p className="font-medium text-foreground">HR Signature</p>
              <p className="text-xs text-muted-foreground">
                {contract.signer?.full_name ? `Signed by ${contract.signer.full_name}` : 'JMAC Enterprise HR'}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-8">
            <div className="border-b border-foreground/40 pb-1" />
            <div>
              <p className="font-medium text-foreground">
                Employee Signature — {applicant?.first_name} {applicant?.last_name}
              </p>
              <p className="text-xs text-muted-foreground">
                {contract.signed_at ? `Signed on ${formatDate(contract.signed_at)}` : 'Date signed'}
              </p>
            </div>
          </div>
        </section>

        <footer className="border-t border-border pt-4 text-center text-[10px] text-muted-foreground print:break-inside-avoid">
          <p>
            {companyName} · Contract Reference {application.reference_code} · This document is system-generated by
            JMAC Enterprise.
          </p>
        </footer>
      </article>
    </div>
  )
}
