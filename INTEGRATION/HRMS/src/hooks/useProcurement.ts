import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Tables, TablesInsert } from '@/lib/database.types'
import { toast } from '@/components/ui/sonner'
import { describeFinanceError } from './useFinanceMasterData'

export type PurchaseOrder = Tables<'purchase_order_status'>
export type PurchaseOrderItem = Tables<'purchase_order_items'>
export type PurchaseOrderSource = Tables<'purchase_order_sources'>
export type ProcurementReceipt = Tables<'procurement_receipts'>

export const PROCUREMENT_KEYS = {
  orders: ['procurement', 'orders'] as const,
  order: (id: string) => ['procurement', 'orders', id] as const,
  items: (id: string) => ['procurement', 'orders', id, 'items'] as const,
  sources: (id: string) => ['procurement', 'orders', id, 'sources'] as const,
  demand: ['procurement', 'demand'] as const,
  deliveries: (branchId: string) => ['procurement', 'deliveries', branchId] as const,
}

/* ------------------------------------------------------------------ orders */

export function usePurchaseOrders() {
  return useQuery({
    queryKey: PROCUREMENT_KEYS.orders,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purchase_order_status')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      return data
    },
  })
}

export function usePurchaseOrderItems(orderId: string | undefined) {
  return useQuery({
    queryKey: PROCUREMENT_KEYS.items(orderId ?? 'none'),
    enabled: !!orderId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purchase_order_items')
        .select('*, pos_products(name), branches(name)')
        .eq('purchase_order_id', orderId!)
        .order('created_at')
      if (error) throw error
      return data as unknown as (PurchaseOrderItem & {
        pos_products: { name: string } | null
        branches: { name: string } | null
      })[]
    },
  })
}

/** What created this order. A link to the demand, never a copy of it. */
export function usePurchaseOrderSources(orderId: string | undefined) {
  return useQuery({
    queryKey: PROCUREMENT_KEYS.sources(orderId ?? 'none'),
    enabled: !!orderId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purchase_order_sources')
        .select('*, finance_requests(request_no, title), pos_inventory_requests(id, product_name_snapshot, requested_quantity)')
        .eq('purchase_order_id', orderId!)
      if (error) throw error
      return data as unknown as (PurchaseOrderSource & {
        finance_requests: { request_no: string | null; title: string } | null
        pos_inventory_requests: {
          id: string
          product_name_snapshot: string | null
          requested_quantity: number
        } | null
      })[]
    },
  })
}

function useProcurementMutation<TInput>(
  run: (input: TInput) => Promise<void>,
  success: string,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['procurement'] })
      toast.success(success)
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

export function useCreatePurchaseOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      order: TablesInsert<'purchase_orders'>
      source?: { financeRequestId?: string; posInventoryRequestId?: string }
    }) => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .insert(input.order)
        .select('id')
        .single()
      if (error) throw error

      if (input.source?.financeRequestId || input.source?.posInventoryRequestId) {
        const { error: linkError } = await supabase.from('purchase_order_sources').insert({
          purchase_order_id: data.id,
          finance_request_id: input.source.financeRequestId ?? null,
          pos_inventory_request_id: input.source.posInventoryRequestId ?? null,
        })
        // The order exists either way; a missing link is worth saying so about
        // rather than pretending the order failed.
        if (linkError) toast.error('The order was created but could not be linked to its source.')
      }
      return data.id
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ['procurement'] })
      toast.success('Purchase order drafted.')
      return id
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

export function useSavePurchaseOrderItem() {
  return useProcurementMutation<TablesInsert<'purchase_order_items'>>(async (values) => {
    const { error } = await supabase.from('purchase_order_items').insert(values)
    if (error) throw error
  }, 'Line added.')
}

export function useRemovePurchaseOrderItem() {
  return useProcurementMutation<{ id: string }>(async ({ id }) => {
    const { error } = await supabase.from('purchase_order_items').delete().eq('id', id)
    if (error) throw error
  }, 'Line removed.')
}

/** The one door for a purchase order's status, mirroring the request chain. */
export function useTransitionPurchaseOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { orderId: string; to: string; remarks?: string | null }) => {
      const { error } = await supabase.rpc('transition_purchase_order', {
        _purchase_order_id: input.orderId,
        _to_status: input.to,
        _remarks: input.remarks ?? undefined,
      })
      if (error) throw error
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ['procurement'] })
      toast.success(
        input.to === 'approved'
          ? 'Purchase order approved. Nothing is received until the branch confirms delivery.'
          : 'Purchase order updated.',
      )
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

/* ------------------------------------------------------------------ demand */

/**
 * What is waiting to be procured.
 *
 * Two independent sources, deliberately not merged into a third table: an
 * approved finance request, and a POS stock request a branch raised. Each keeps
 * its own lifecycle and its own home; procurement links to them.
 */
export interface ProcurementDemand {
  source_kind: 'finance_request' | 'pos_restock'
  source_id: string
  reference: string | null
  title: string | null
  branch_id: string | null
  branch_name: string | null
  product_id: string | null
  requested_quantity: number | null
  amount: number | null
  reason: string | null
  requested_by_name: string | null
  requested_at: string | null
  demand_state: 'awaiting_finance_review' | 'accepted_for_procurement' | 'awaiting_procurement' | 'ordered'
  purchase_order_id: string | null
  purchase_order_no: string | null
  purchase_order_status: string | null
}

export const DEMAND_STATE_LABEL: Record<string, string> = {
  awaiting_finance_review: 'Awaiting Finance review',
  accepted_for_procurement: 'Accepted for procurement',
  awaiting_procurement: 'Awaiting procurement',
  ordered: 'Ordered',
}

/**
 * What Finance is waiting to procure.
 *
 * One server-authoritative call rather than two client queries. The previous
 * version read pos_inventory_requests directly with status = 'approved', which
 * quietly preserved the Administrator gate this correction removes — a branch
 * could ask for stock and Finance would never see it.
 *
 * It also swallowed a failure into an empty list, so a permission problem, a
 * broken query and genuinely nothing to do all rendered as "Demand (0)". The
 * error is surfaced now: a page that cannot load its work should say so.
 */
/**
 * Purchase order statuses that still represent procurement against a demand.
 *
 * The same list pos_request_live_purchase_orders() uses, named here so the
 * screen and the server cannot disagree about what "live" means. `closed` is
 * finished and `cancelled`/`rejected` released the demand -- those do not stop
 * Finance Staff resolving the underlying request.
 *
 * Advisory only. The server re-reads this under a row lock at the moment of the
 * decision, so a stale screen is refused rather than believed.
 */
export const LIVE_PURCHASE_ORDER_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'returned',
] as const

export function hasLivePurchaseOrder(status: string | null | undefined): boolean {
  return !!status && (LIVE_PURCHASE_ORDER_STATUSES as readonly string[]).includes(status)
}

export function useProcurementDemand() {
  return useQuery({
    queryKey: PROCUREMENT_KEYS.demand,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_procurement_demand')
      if (error) throw error
      return (data ?? []) as ProcurementDemand[]
    },
  })
}

/** Finance Staff accepting branch demand for procurement.
 *
 *  Deliberately labelled differently from the Finance Manager's approval of a
 *  purchase order: one says this should be bought, the other commits the
 *  company to buying it. Calling both "Approve" is how a two-step control
 *  starts looking like a formality. */
export function useAcceptRestockDemand() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { requestId: string; note?: string | null }) => {
      const { error } = await supabase.rpc('approve_pos_request', {
        _request_id: input.requestId,
        _note: input.note ?? 'Accepted for procurement',
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['procurement'] })
      toast.success('Accepted for procurement. Raise a purchase order when you are ready.')
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

/**
 * Finance Staff sending a stock request back to the branch to correct.
 *
 * NOT a rejection, and the distinction is the whole feature. The demand may be
 * perfectly legitimate; something about it -- usually the quantity, or a
 * selling price that makes the purchase a loss -- has to be looked at by the
 * person who raised it. The request keeps its identity, so the branch corrects
 * and resubmits the same request instead of raising a duplicate.
 *
 * The server refuses while any purchase order still claims the request, so this
 * cannot leave a rejected demand with a live order against it.
 */
export function useReturnRestockDemand() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { requestId: string; reason: string }) => {
      const { error } = await supabase.rpc('return_pos_request', {
        _request_id: input.requestId,
        _reason: input.reason,
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['procurement'] })
      queryClient.invalidateQueries({ queryKey: ['pos-requests'] })
      toast.success('Returned to the branch. They will correct it and resubmit.')
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

/**
 * Finance Staff closing a stock request: this demand will not be procured.
 *
 * Terminal. The toast used to say "Returned to the branch with your reason",
 * which was the wrong word for it in a workflow that now has a real return --
 * the branch reading that would have waited for a correction they were never
 * going to be asked for.
 */
export function useDeclineRestockDemand() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { requestId: string; note: string }) => {
      const { error } = await supabase.rpc('decline_pos_request', {
        _request_id: input.requestId,
        _note: input.note,
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['procurement'] })
      queryClient.invalidateQueries({ queryKey: ['pos-requests'] })
      toast.success('Request rejected. The branch can see your reason.')
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

/* -------------------------------------------------------------- deliveries */

export interface BranchDelivery {
  purchase_order_item_id: string
  po_number: string | null
  expected_delivery_date: string | null
  product_id: string
  product_name: string
  quantity_ordered: number
  quantity_received: number
  quantity_outstanding: number
}

/**
 * What a branch is waiting to receive.
 *
 * Product and quantities only. No unit cost, no line total, no vendor terms:
 * confirming that units arrived is not a reason to learn what the company pays
 * for them. The database function decides that, not this query.
 */
export function useBranchDeliveries(branchId: string | undefined) {
  return useQuery({
    queryKey: PROCUREMENT_KEYS.deliveries(branchId ?? 'none'),
    enabled: !!branchId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_branch_deliveries', { _branch_id: branchId! })
      if (error) throw error
      return (data ?? []) as BranchDelivery[]
    },
  })
}

/**
 * Confirm a physical delivery.
 *
 * The idempotency key is generated once per receiving action and reused on
 * every retry, so a double-click, a refresh mid-flight or a flaky connection
 * produces one receipt and one inventory movement. There is no cost parameter:
 * the server takes it from the approved order line.
 */
export function useReceiveDelivery(branchId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      purchaseOrderItemId: string
      quantity: number
      deliveryReference?: string | null
      idempotencyKey: string
    }) => {
      const { error } = await supabase.rpc('receive_procurement_stock', {
        _purchase_order_item_id: input.purchaseOrderItemId,
        _quantity: input.quantity,
        _delivery_reference: input.deliveryReference ?? undefined,
        _idempotency_key: input.idempotencyKey,
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROCUREMENT_KEYS.deliveries(branchId ?? 'none') })
      // These are the POS keys receiving actually moves. They were ['pos'] and
      // ['branch-inventory'], which match NOTHING: every POS key is its own
      // string, 'pos-branch-inventory' and 'pos-catalogue', and invalidation
      // compares elements rather than prefixes of one. So confirming a delivery
      // refreshed no POS screen at all -- the branch's Inventory page and the
      // manager's dashboard both kept showing the stock from before it arrived.
      queryClient.invalidateQueries({ queryKey: ['pos-branch-inventory'] })
      queryClient.invalidateQueries({ queryKey: ['pos-inventory-movements'] })
      queryClient.invalidateQueries({ queryKey: ['pos-catalogue'] })
      // Receiving changes what Finance sees too: the order's received and
      // outstanding quantities, the demand queue, and the branch's own progress
      // view. Only the POS keys were invalidated before, so a Finance tab left
      // open kept showing "awaiting delivery" against an order that had fully
      // arrived. The whole procurement namespace goes, rather than a list of
      // keys somebody has to remember to extend.
      queryClient.invalidateQueries({ queryKey: ['procurement'] })
      toast.success('Delivery confirmed. Branch stock has been updated.')
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

export const PO_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  pending_approval: 'With the Finance Manager',
  approved: 'Approved — awaiting delivery',
  returned: 'Returned for revision',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  closed: 'Closed',
}

/* ------------------------------------------------ the branch's own view */

/**
 * What became of what this branch asked for.
 *
 * Read from the procurement documents rather than copied into the request, so
 * there is no second version of the truth to fall out of step. The function
 * returns no cost of any kind: a POS Manager is told what was ordered and what
 * arrived, never what it cost or who supplied it.
 */
export const REQUEST_PROGRESS_LABEL: Record<string, string> = {
  with_finance: 'With Finance',
  procurement_reopened: 'Procurement reopened — previous order cancelled',
  accepted: 'Accepted — not yet ordered',
  being_ordered: 'Being ordered',
  ordered: 'Ordered — awaiting delivery',
  part_delivered: 'Part delivered',
  delivered: 'Delivered',
  order_stopped: 'Order stopped',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
}

export interface BranchRequestProgress {
  request_id: string
  product_id: string | null
  product_name: string | null
  requested_quantity: number | null
  requested_at: string | null
  request_status: string | null
  po_number: string | null
  po_status: string | null
  quantity_ordered: number | null
  quantity_received: number | null
  quantity_outstanding: number | null
  progress: string | null
}

export function useBranchRequestProgress(branchId: string | undefined) {
  return useQuery({
    queryKey: ['procurement', 'branch-progress', branchId ?? 'none'],
    enabled: !!branchId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_branch_request_progress', {
        _branch_id: branchId!,
      })
      // Surfaced, never swallowed: an empty list has to mean "nothing asked
      // for", not "the query failed and nobody noticed".
      if (error) throw error
      return (data ?? []) as BranchRequestProgress[]
    },
  })
}

/* ------------------------------------------------- building an order */

export interface ProcurementSourceRef {
  kind: 'pos_restock' | 'finance_request'
  id: string
  label: string
}

export interface ProcurementSource {
  source_kind: string
  source_id: string
  reference: string | null
  title: string | null
  product_id: string | null
  product_name: string | null
  branch_id: string | null
  branch_name: string | null
  requested_quantity: number | null
  ordered_quantity: number | null
  outstanding: number | null
  requested_by_name: string | null
  amount: number | null
  /**
   * What the DESTINATION branch charges for this product today, pre-VAT.
   *
   * Resolved by the server from the request's own product and branch -- never
   * another branch's price, and never the enterprise default for a product the
   * branch does not carry. Null when there is no usable price, which is a
   * refusal rather than a zero. Finance reads it; Finance does not set it, and
   * the margin guard reloads it independently at submission and approval.
   */
  branch_selling_price: number | null
}

/**
 * What the request already knows, read once when the builder opens.
 *
 * A narrow answer on purpose. It gives Finance this product and this branch --
 * not the catalogue they came from, which Finance has no business reading and
 * which was never the point of fulfilling one restock request.
 */
export function useProcurementSource(ref: ProcurementSourceRef | null) {
  return useQuery({
    queryKey: ['procurement', 'source', ref?.kind ?? 'none', ref?.id ?? 'none'],
    enabled: !!ref,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_procurement_source', {
        _source_kind: ref!.kind,
        _source_id: ref!.id,
      })
      if (error) throw error
      return (data?.[0] ?? null) as ProcurementSource | null
    },
  })
}

export interface PurchaseOrderMargin {
  item_id: string
  description: string
  quantity_ordered: number
  unit_cost: number
  /** The destination branch's price as it is NOW, recomputed on read. */
  current_selling_price: number | null
  /** The price the margin guard last validated this line against -- at
   *  submission, and again at approval. Null on a line that never transitioned. */
  selling_price_snapshot: number | null
  branch_name: string | null
}

/**
 * The pricing context an approver is entitled to before committing the company.
 *
 * Recomputed rather than replayed. A Finance Manager approving an order needs
 * the price as it is at the moment they approve, not the one that was true when
 * Staff typed the cost -- those can differ, and the difference is exactly what
 * they should be told about. POS-sourced lines only; a stationery order has no
 * retail price and no margin.
 */
export function usePurchaseOrderMargins(orderId: string | undefined) {
  return useQuery({
    queryKey: ['procurement', 'margins', orderId ?? 'none'],
    enabled: !!orderId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_purchase_order_margins', {
        _purchase_order_id: orderId!,
      })
      if (error) throw error
      return (data ?? []) as unknown as PurchaseOrderMargin[]
    },
  })
}

/**
 * The order, its link to the demand and its lines, in one server call.
 *
 * Deliberately not three requests: the previous flow created the order first
 * and left it behind whenever anything after that did not happen.
 */
export function useBuildPurchaseOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      source: ProcurementSourceRef
      vendorId: string
      expectedDelivery: string | null
      notes: string | null
      budgetId: string | null
      quantity: number | null
      unitCost: number | null
      lines: Array<{ description: string; quantity: number; unit_cost: number }> | null
      submit: boolean
    }) => {
      const { data, error } = await supabase.rpc('create_purchase_order_from_source', {
        _source_kind: input.source.kind,
        _source_id: input.source.id,
        _vendor_id: input.vendorId,
        _expected_delivery_date: input.expectedDelivery ?? undefined,
        _notes: input.notes ?? undefined,
        _budget_id: input.budgetId ?? undefined,
        _quantity: input.quantity ?? undefined,
        _unit_cost: input.unitCost ?? undefined,
        _lines: input.lines ?? undefined,
        _submit: input.submit,
      })
      if (error) throw error
      return { id: data as unknown as string, submitted: input.submit }
    },
    onSuccess: ({ submitted }) => {
      queryClient.invalidateQueries({ queryKey: ['procurement'] })
      toast.success(
        submitted ? 'Purchase order submitted for approval.' : 'Purchase order saved as a draft.',
      )
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

/** Abandoning a draft somebody deliberately saved. Takes a reason, and hands
 *  the demand back to the procurement queue. */
export function useDiscardDraft() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc('discard_purchase_order_draft', {
        _purchase_order_id: id,
        _reason: reason,
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['procurement'] })
      toast.success('Draft discarded. The demand is back in the procurement queue.')
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

/** Stop what has not arrived, without pretending what did arrive never did. */
export function useCancelRemainder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc('cancel_purchase_order_remainder', {
        _purchase_order_id: id,
        _reason: reason,
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['procurement'] })
      queryClient.invalidateQueries({ queryKey: ['pos'] })
      toast.success('Outstanding quantity stopped. Everything already received stands.')
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

/* ------------------------------------------------- what has actually arrived */

/**
 * Where an order stands, as opposed to what its status column says.
 *
 * These are two different questions and the page was answering the second when
 * it was asked the first. PO-2026-0004 was approved, twenty ordered and twenty
 * received, and every screen still read "Approved — awaiting delivery" beside
 * "20 of 20 received", because the label came from the status alone.
 *
 * The workflow status stays authoritative and stays the Finance Manager's:
 * receiving twenty crates does not close an order, a person does. What changes
 * is that the visible state is derived from the quantities, so the screen stops
 * contradicting the numbers printed next to it.
 */
export type Fulfillment =
  | 'awaiting'
  | 'partial'
  | 'complete'
  | 'not_receivable'
  | 'workflow'

export interface FulfillmentView {
  kind: Fulfillment
  label: string
  tone: 'default' | 'secondary' | 'success' | 'warning' | 'destructive'
}

export function fulfillmentOf(order: {
  status?: string | null
  quantity_ordered?: number | null
  quantity_received?: number | null
  quantity_outstanding?: number | null
}): FulfillmentView {
  const status = order.status ?? ''

  // Anything that is not an approved, live order is described by its workflow
  // state. A draft has nothing to be awaiting.
  if (status !== 'approved') {
    return {
      kind: 'workflow',
      label: PO_STATUS_LABEL[status] ?? status,
      tone: status === 'closed' ? 'secondary' : ['rejected', 'cancelled'].includes(status)
        ? 'destructive'
        : 'secondary',
    }
  }

  const received = Number(order.quantity_received ?? 0)
  const outstanding = Number(order.quantity_outstanding ?? 0)

  if (received === 0 && outstanding === 0) {
    // An approved order with nothing to receive: services, rent, a licence.
    return { kind: 'not_receivable', label: 'Approved', tone: 'default' }
  }
  if (received === 0) {
    return { kind: 'awaiting', label: 'Approved — awaiting delivery', tone: 'default' }
  }
  if (outstanding > 0) {
    return { kind: 'partial', label: 'Partially received', tone: 'warning' }
  }
  return { kind: 'complete', label: 'Fully received — ready to close', tone: 'success' }
}

/** The sentence under an approved order, matching what the numbers say. */
export function fulfillmentNote(order: {
  status?: string | null
  quantity_ordered?: number | null
  quantity_received?: number | null
  quantity_outstanding?: number | null
}): string | null {
  const view = fulfillmentOf(order)
  const ordered = Number(order.quantity_ordered ?? 0)
  const received = Number(order.quantity_received ?? 0)
  const outstanding = Number(order.quantity_outstanding ?? 0)

  switch (view.kind) {
    case 'awaiting':
      return 'Approved. No units have been received yet. The destination branch confirms physical delivery, and that is what updates inventory.'
    case 'partial':
      return `Partially received. ${received} of ${ordered} units have arrived; ${outstanding} remain outstanding.`
    case 'complete':
      return `Delivery complete. All ${received} units have been received and branch stock has been updated. This purchase order is ready to close.`
    case 'not_receivable':
      return 'Approved. Nothing on this order is POS stock, so there is no delivery to receive and no inventory to move.'
    default:
      return null
  }
}
