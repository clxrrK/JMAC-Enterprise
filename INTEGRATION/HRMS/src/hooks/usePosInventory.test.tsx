import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * The stock cache, and who moves it.
 *
 * The dashboard's "Needs attention" card reads `useBranchInventory`, whose key
 * is `['pos-branch-inventory', branchId]`. That is not an incidental
 * implementation detail: it is the whole refresh mechanism. The card needed no
 * new plumbing to stay current because every write that moves a quantity
 * already invalidates this key -- checkout does (see usePosTill.test.tsx), and
 * so must receiving and adjustment, which is what this file holds.
 *
 * Invalidation is by key PREFIX, so one call covers every branch's entry.
 */

const rpc = vi.fn()

/** Enough of the query builder for the one non-RPC write below: carrying a
 * product is an upsert on pos_branch_products, dropping it a filtered delete.
 * A real Promise with `.eq()` hung off it, because that is what the builder is:
 * awaitable at any point in the chain. */
function builder(): Promise<{ error: null }> & { eq: () => ReturnType<typeof builder> } {
  const pending = Promise.resolve({ error: null }) as Promise<{ error: null }> & {
    eq: () => ReturnType<typeof builder>
  }
  pending.eq = () => builder()
  return pending
}

const from = vi.fn(() => ({ upsert: vi.fn(() => builder()), delete: vi.fn(() => builder()) }))

vi.mock('@/lib/supabase', () => ({
  supabase: { rpc, from },
}))

vi.mock('@/components/ui/sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const { useAdjustStock, useBranchInventory, useReceiveStock } = await import(
  '@/hooks/usePosInventory'
)
const { useSetBranchCarries } = await import('@/hooks/usePosCatalogue')
const { useReceiveDelivery } = await import('@/hooks/useProcurement')

afterEach(() => {
  cleanup()
  rpc.mockReset()
})

function harness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { wrapper, invalidate }
}

const invalidatedKeys = (invalidate: { mock: { calls: unknown[][] } }) =>
  invalidate.mock.calls.map(
    (call) => (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0]
  )

describe('the key the stock card depends on', () => {
  it('is the one useBranchInventory reads, scoped to the branch', () => {
    rpc.mockResolvedValue({ data: [], error: null })
    const { wrapper } = harness()
    const { result } = renderHook(() => useBranchInventory('branch-a'), { wrapper })

    // Named here so a rename cannot silently detach the dashboard card from
    // the writes that are supposed to refresh it.
    expect(rpc).toHaveBeenCalledWith('get_branch_inventory', { _branch_id: 'branch-a' })
    expect(result.current).toBeTruthy()
  })

  it('is not asked for at all until there is a branch', () => {
    const { wrapper } = harness()
    const { result } = renderHook(() => useBranchInventory(undefined), { wrapper })

    expect(rpc).not.toHaveBeenCalled()
    // Neither loading nor failed nor successful: the state the dashboard card
    // must not mistake for "the shelf is fine".
    expect(result.current.isSuccess).toBe(false)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isError).toBe(false)
  })

  it('is refreshed when a delivery is received', async () => {
    rpc.mockResolvedValue({ error: null })
    const { wrapper, invalidate } = harness()
    const { result } = renderHook(() => useReceiveStock(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        branchId: 'branch-a',
        productId: 'product-a',
        quantity: 12,
        unitCost: 20,
      })
    })

    expect(invalidatedKeys(invalidate)).toContain('pos-branch-inventory')
  })

  it('is refreshed when stock is adjusted', async () => {
    rpc.mockResolvedValue({ error: null })
    const { wrapper, invalidate } = harness()
    const { result } = renderHook(() => useAdjustStock(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        branchId: 'branch-a',
        productId: 'product-a',
        quantityChange: -3,
        reason: 'damaged',
      })
    })

    expect(invalidatedKeys(invalidate)).toContain('pos-branch-inventory')
  })

  it('is refreshed when a branch starts or stops carrying a product', async () => {
    // No quantity moves here, which is exactly why it was missed: the insert
    // into pos_branch_products fires trg_create_branch_inventory and the branch
    // gains a row at zero -- a new out-of-stock alert. Removal cascades it away.
    rpc.mockResolvedValue({ error: null })
    const { wrapper, invalidate } = harness()
    const { result } = renderHook(() => useSetBranchCarries(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        branchId: 'branch-a',
        productId: 'product-a',
        carries: true,
      })
    })

    expect(invalidatedKeys(invalidate)).toContain('pos-branch-inventory')
  })

  it('is refreshed when a procurement delivery is confirmed', async () => {
    // The POS Manager's own receiving path, and the one that was broken: it
    // invalidated ['pos'] and ['branch-inventory'], neither of which is a key
    // this app has. Confirming a delivery refreshed no POS screen at all.
    rpc.mockResolvedValue({ error: null })
    const { wrapper, invalidate } = harness()
    const { result } = renderHook(() => useReceiveDelivery('branch-a'), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        purchaseOrderItemId: 'poi-1',
        quantity: 10,
        idempotencyKey: 'delivery-1',
      })
    })

    expect(invalidatedKeys(invalidate)).toContain('pos-branch-inventory')
  })

  it('is left alone when the write failed', async () => {
    // A refused adjustment moved no stock, so the card has nothing to re-read.
    rpc.mockResolvedValue({ error: { message: 'permission denied' } })
    const { wrapper, invalidate } = harness()
    const { result } = renderHook(() => useAdjustStock(), { wrapper })

    await act(async () => {
      await result.current
        .mutateAsync({
          branchId: 'branch-a',
          productId: 'product-a',
          quantityChange: -3,
          reason: 'damaged',
        })
        .catch(() => undefined)
    })

    expect(invalidatedKeys(invalidate)).not.toContain('pos-branch-inventory')
  })
})
