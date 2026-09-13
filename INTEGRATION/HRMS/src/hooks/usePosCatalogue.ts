import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { toast } from '@/components/ui/sonner'
import type { PosProductStatus } from '@/lib/enums'
import {
  describeCatalogueError,
  productImagePath,
  type BranchProduct,
  type Category,
  type Product,
} from '@/lib/posCatalogue'

/**
 * The POS catalogue.
 *
 * Two audiences, two paths:
 *
 *   Administration  reads pos_products / pos_product_categories directly. RLS
 *                   on both is is_admin(), so nobody else gets a row.
 *   POS portal      reads get_pos_catalogue() / get_pos_categories(), SECURITY
 *                   DEFINER RPCs that return only what a till needs and never
 *                   select a cost column.
 *
 * The split is deliberate: a table policy that permitted POS staff to SELECT
 * would leave cost one careless `select *` away. Not exposing the table is a
 * stronger guarantee than trusting every future query's column list.
 */

export const PRODUCT_IMAGE_BUCKET = 'pos-product-images'

/** Product images are not credentials, and a catalogue page renders many at
 * once, so they get a longer signature than the payment QR's five minutes. */
const IMAGE_URL_TTL_SECONDS = 3600

const CATEGORIES_KEY = ['pos-categories']
const PRODUCTS_KEY = ['pos-products']
const BRANCH_PRODUCTS_KEY = ['pos-branch-products']
const POS_CATALOGUE_KEY = ['pos-catalogue']

/* ------------------------------------------------------------------ admin */

export function usePosCategories() {
  return useQuery({
    queryKey: CATEGORIES_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pos_product_categories')
        .select('id, name, normalized_name, description, color, icon, is_active, sort_order')
        .order('sort_order')
        .order('name')
      if (error) throw error
      return data as unknown as Category[]
    },
  })
}

/* ----------------------------------------------------------- POS portal */

/**
 * A category as the POS portal may see one.
 *
 * Deliberately smaller than `Category`. get_pos_categories() returns taxonomy
 * and nothing else, and in particular returns no `is_active` -- it filters on
 * it server-side instead, so every row that arrives is already selectable.
 * That absence is load-bearing: a caller that copies the Administrator's
 * `.filter(c => c.is_active)` onto these rows filters on `undefined` and
 * silently discards all of them, which is the second half of the bug this
 * type exists to make impossible to write.
 */
export interface PosPortalCategory {
  id: string
  name: string
  color: string | null
  sort_order: number
}

/**
 * The global category list, for POS staff.
 *
 * This is the portal's half of the split the file docstring describes, and it
 * had no hook until now -- so the POS Manager's Add Product dialog reached for
 * usePosCategories() instead. That reads pos_product_categories directly,
 * whose RLS is is_admin(), and RLS filters rows rather than raising: the query
 * SUCCEEDED, returned zero rows, and the dropdown rendered an empty list with
 * no error to explain it. A manager looking at General and Drinks on the
 * Categories page was offered neither here.
 *
 * get_pos_categories() is the intended reader: SECURITY DEFINER, gated on
 * has_pos_access(), ordered by sort_order then name, and already limited to
 * active categories. It is the same taxonomy the Administrator edits -- same
 * ids, same names -- viewed through a function POS staff are allowed to call,
 * so the two surfaces cannot disagree about what exists.
 *
 * Keyed under POS_CATALOGUE_KEY on purpose: every catalogue mutation, creating
 * a category included, already invalidates that prefix, so an inline-created
 * category appears here without anything else being taught about it.
 */
export function usePosPortalCategories() {
  return useQuery({
    queryKey: [...POS_CATALOGUE_KEY, 'categories'],
    queryFn: async (): Promise<PosPortalCategory[]> => {
      const { data, error } = await supabase.rpc('get_pos_categories')
      if (error) throw new Error(describeCatalogueError(error))
      return (data ?? []) as unknown as PosPortalCategory[]
    },
  })
}

export function usePosProducts() {
  return useQuery({
    queryKey: PRODUCTS_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pos_products')
        .select('id, name, category_id, default_selling_price, default_unit_cost, image_path, status')
        .order('name')
      if (error) throw error
      return data as unknown as Product[]
    },
  })
}

/** Every branch catalogue row the caller may read. An Administrator sees all
 * branches; a POS Manager or cashier sees only branches they are assigned to. */
export function useBranchProducts() {
  return useQuery({
    queryKey: BRANCH_PRODUCTS_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pos_branch_products')
        .select('branch_id, product_id, is_available, selling_price_override')
      if (error) throw error
      return data as unknown as BranchProduct[]
    },
  })
}

/* ------------------------------------------------------------- POS portal */

export interface CatalogueRow {
  product_id: string
  name: string
  category_id: string
  category_name: string
  selling_price: number
  image_path: string | null
  /** Named for the contract, not the storage column: Phase 5 can subtract
   * reservations without every caller changing. */
  available_quantity: number
  /** Computed server-side, so the numeric threshold never reaches a till. */
  is_low_stock: boolean
}

export interface ManagedCatalogueRow extends CatalogueRow {
  is_available: boolean
  product_status: PosProductStatus
}

/**
 * Everything a branch carries, paused entries included, for the POS Manager who
 * administers availability. Manager-only in the database; a cashier calling it
 * gets an empty set.
 */
export function useBranchCatalogueManagement(branchId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [...POS_CATALOGUE_KEY, 'managed', branchId ?? 'none'],
    enabled: !!branchId && enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_branch_catalogue_management', {
        _branch_id: branchId!,
      })
      if (error) throw error
      return (data ?? []) as unknown as ManagedCatalogueRow[]
    },
  })
}

/** What a till may see at a branch. No cost, by construction. */
export function usePosCatalogue(branchId: string | undefined) {
  return useQuery({
    queryKey: [...POS_CATALOGUE_KEY, branchId ?? 'none'],
    enabled: !!branchId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_pos_catalogue', { _branch_id: branchId! })
      if (error) throw error
      return (data ?? []) as unknown as CatalogueRow[]
    },
  })
}

/* --------------------------------------------------------------- images */

/**
 * Signed URLs for a page's worth of product images, in one round trip.
 *
 * `createSignedUrls` batches; signing each image separately would be one
 * request per row. Missing or unreadable paths resolve to null rather than
 * failing the page -- a broken image is better than a blank catalogue.
 */
export function useProductImageUrls(paths: (string | null | undefined)[]) {
  const wanted = Array.from(new Set(paths.filter((p): p is string => !!p))).sort()
  return useQuery({
    queryKey: ['pos-product-images', wanted.join('|')],
    enabled: wanted.length > 0,
    staleTime: (IMAGE_URL_TTL_SECONDS - 120) * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .createSignedUrls(wanted, IMAGE_URL_TTL_SECONDS)
      if (error) throw error
      const map: Record<string, string> = {}
      for (const entry of data ?? []) {
        if (entry.path && entry.signedUrl) map[entry.path] = entry.signedUrl
      }
      return map
    },
  })
}

/* ------------------------------------------------------------ mutations */

function useInvalidateCatalogue() {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY })
    queryClient.invalidateQueries({ queryKey: PRODUCTS_KEY })
    queryClient.invalidateQueries({ queryKey: BRANCH_PRODUCTS_KEY })
    queryClient.invalidateQueries({ queryKey: POS_CATALOGUE_KEY })
    // A catalogue change moves branch INVENTORY too, which is easy to miss
    // because no quantity moved. Starting to carry a product fires
    // trg_create_branch_inventory and creates a row at zero -- an immediate
    // out-of-stock alert on the dashboard; stopping carrying one cascades the
    // row away. Both change what the stock card must show.
    queryClient.invalidateQueries({ queryKey: ['pos-branch-inventory'] })
  }
}

export interface SaveCategoryInput {
  id?: string
  name: string
  description?: string
  color?: string
}

export function useSaveCategory() {
  const invalidate = useInvalidateCatalogue()
  return useMutation({
    mutationFn: async ({ id, name, description, color }: SaveCategoryInput) => {
      const payload = {
        name: name.trim(),
        description: description?.trim() || null,
        color: color?.trim() || null,
      }
      const { error } = id
        ? await supabase.from('pos_product_categories').update(payload).eq('id', id)
        : await supabase.from('pos_product_categories').insert(payload)
      if (error) throw new Error(describeCatalogueError(error))
      return !!id
    },
    onSuccess: (wasUpdate) => {
      invalidate()
      toast.success(wasUpdate ? 'Category updated' : 'Category added')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useSetCategoryActive() {
  const invalidate = useInvalidateCatalogue()
  return useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const { error } = await supabase
        .from('pos_product_categories')
        .update({ is_active: isActive })
        .eq('id', id)
      if (error) throw new Error(describeCatalogueError(error))
      return isActive
    },
    onSuccess: (isActive) => {
      invalidate()
      toast.success(isActive ? 'Category restored' : 'Category archived')
    },
    onError: (error) => toast.error(error.message),
  })
}

/** Deleting needs somewhere for the category's products to go: category_id is
 * NOT NULL, so the RPC refuses without a replacement. */
export function useDeleteCategory() {
  const invalidate = useInvalidateCatalogue()
  return useMutation({
    mutationFn: async ({ id, replacementId }: { id: string; replacementId: string | null }) => {
      const { error } = await supabase.rpc('delete_pos_category', {
        _category_id: id,
        // The generated type models the defaulted argument as optional, not
        // nullable. Omitting it lets the SQL default (null) apply, which is the
        // same "no replacement" the RPC checks for.
        _replacement_id: replacementId ?? undefined,
      })
      if (error) throw new Error(describeCatalogueError(error))
    },
    onSuccess: () => {
      invalidate()
      toast.success('Category deleted')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useReorderCategory() {
  const invalidate = useInvalidateCatalogue()
  return useMutation({
    mutationFn: async ({ id, direction }: { id: string; direction: -1 | 1 }) => {
      const { error } = await supabase.rpc('reorder_pos_category', {
        _category_id: id,
        _direction: direction,
      })
      if (error) throw new Error(describeCatalogueError(error))
    },
    onSuccess: () => invalidate(),
    onError: (error) => toast.error(error.message),
  })
}

export interface SaveProductInput {
  id?: string
  name: string
  categoryId: string
  sellingPrice: number
  unitCost: number
  status: PosProductStatus
}

export function useSaveProduct() {
  const invalidate = useInvalidateCatalogue()
  return useMutation({
    mutationFn: async ({ id, name, categoryId, sellingPrice, unitCost, status }: SaveProductInput) => {
      const payload = {
        name: name.trim(),
        category_id: categoryId,
        default_selling_price: sellingPrice,
        default_unit_cost: unitCost,
        status,
      }
      const { error } = id
        ? await supabase.from('pos_products').update(payload).eq('id', id)
        : await supabase.from('pos_products').insert(payload)
      if (error) throw new Error(describeCatalogueError(error))
      return !!id
    },
    onSuccess: (wasUpdate) => {
      invalidate()
      toast.success(wasUpdate ? 'Product updated' : 'Product added')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useUploadProductImage() {
  const invalidate = useInvalidateCatalogue()
  return useMutation({
    mutationFn: async ({
      productId,
      file,
      previousPath,
    }: {
      productId: string
      file: File
      previousPath: string | null
    }) => {
      if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.')
      if (file.size > 5 * 1024 * 1024) throw new Error('The image must be under 5MB.')

      const path = productImagePath(productId, file.name)
      const { error: uploadError } = await supabase.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .upload(path, file)
      if (uploadError) throw new Error(describeCatalogueError(uploadError))

      const { error } = await supabase
        .from('pos_products')
        .update({ image_path: path })
        .eq('id', productId)
      if (error) {
        // The row is the record of truth. If it could not be written, the object
        // just uploaded is unreferenced -- remove it rather than leaving a file
        // nothing points at.
        await supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove([path])
        throw new Error(describeCatalogueError(error))
      }

      if (previousPath && previousPath !== path) {
        await supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove([previousPath])
      }
    },
    onSuccess: () => {
      invalidate()
      toast.success('Product image updated')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useRemoveProductImage() {
  const invalidate = useInvalidateCatalogue()
  return useMutation({
    mutationFn: async ({ productId, path }: { productId: string; path: string }) => {
      const { error } = await supabase
        .from('pos_products')
        .update({ image_path: null })
        .eq('id', productId)
      if (error) throw new Error(describeCatalogueError(error))
      await supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove([path])
    },
    onSuccess: () => {
      invalidate()
      toast.success('Product image removed')
    },
    onError: (error) => toast.error(error.message),
  })
}

/** Administrator only: deciding that a branch carries a product at all. */
export function useSetBranchCarries() {
  const invalidate = useInvalidateCatalogue()
  return useMutation({
    mutationFn: async ({
      branchId,
      productId,
      carries,
    }: {
      branchId: string
      productId: string
      carries: boolean
    }) => {
      const { error } = carries
        ? await supabase
            .from('pos_branch_products')
            .upsert({ branch_id: branchId, product_id: productId }, { onConflict: 'branch_id,product_id' })
        : await supabase
            .from('pos_branch_products')
            .delete()
            .eq('branch_id', branchId)
            .eq('product_id', productId)
      if (error) throw new Error(describeCatalogueError(error))
      return carries
    },
    onSuccess: (carries) => {
      invalidate()
      toast.success(carries ? 'Added to the branch' : 'Removed from the branch')
    },
    onError: (error) => toast.error(error.message),
  })
}

/**
 * The one write a POS Manager holds: whether their branch is currently
 * offering a product it already carries. The trigger on pos_branch_products
 * refuses anything else they might send.
 */
export function useSetBranchAvailability() {
  const invalidate = useInvalidateCatalogue()
  return useMutation({
    mutationFn: async ({
      branchId,
      productId,
      isAvailable,
    }: {
      branchId: string
      productId: string
      isAvailable: boolean
    }) => {
      const { error } = await supabase
        .from('pos_branch_products')
        .update({ is_available: isAvailable })
        .eq('branch_id', branchId)
        .eq('product_id', productId)
      if (error) throw new Error(describeCatalogueError(error))
      return isAvailable
    },
    onSuccess: (isAvailable) => {
      invalidate()
      toast.success(isAvailable ? 'Available at this branch' : 'Paused at this branch')
    },
    onError: (error) => toast.error(error.message),
  })
}

/** Administrator only: a branch-specific price. */
export function useSetBranchPrice() {
  const invalidate = useInvalidateCatalogue()
  return useMutation({
    mutationFn: async ({
      branchId,
      productId,
      price,
    }: {
      branchId: string
      productId: string
      price: number | null
    }) => {
      const { error } = await supabase
        .from('pos_branch_products')
        .update({ selling_price_override: price })
        .eq('branch_id', branchId)
        .eq('product_id', productId)
      if (error) throw new Error(describeCatalogueError(error))
    },
    onSuccess: () => {
      invalidate()
      toast.success('Branch price updated')
    },
    onError: (error) => toast.error(error.message),
  })
}

/* ------------------------------------------------------ a manager's catalogue
 *
 * A branch manager can decide what their own branch sells: carry something the
 * company already lists, create something it does not, and price it here.
 * Every one of these goes through an RPC that re-checks the branch from the
 * caller's own assignments -- the branch id in the payload is a request, not a
 * permission -- and none of them can see or set cost.
 */

/** Products the company sells that this branch does not carry yet. */
export function useCarryableCatalogue(branchId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [...POS_CATALOGUE_KEY, 'carryable', branchId ?? 'none'],
    enabled: !!branchId && enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_pos_carryable_products', {
        _branch_id: branchId!,
      })
      if (error) throw error
      return (data ?? []) as unknown as {
        product_id: string
        product_name: string
        category_name: string
      }[]
    },
  })
}

const POS_CATALOGUE_ERRORS: Record<string, string> = {
  POS_BRANCH_FORBIDDEN: 'You can only manage the branch you are assigned to.',
  POS_PRODUCT_NOT_FOUND: 'That product is no longer available.',
  POS_PRODUCT_ALREADY_CARRIED: 'This branch already carries that product.',
  POS_PRODUCT_NAME_REQUIRED: 'Give the product a name.',
  POS_PRICE_INVALID: 'Enter a valid selling price.',
  POS_CATEGORY_NOT_FOUND: 'Choose a category.',
  POS_CATEGORY_FORBIDDEN: 'You do not have permission to manage categories.',
  POS_CATEGORY_NAME_REQUIRED: 'Give the category a name.',
  POS_CATEGORY_EXISTS: 'A category with that name already exists.',
  POS_PRODUCT_NOT_CARRIED: 'This branch does not carry that product.',
}

/** The database reports a duplicate as POS_PRODUCT_EXISTS:<id> so the screen
 *  can offer the product that already exists instead of just refusing. */
export function existingProductIdFrom(message: string): string | null {
  const match = /POS_PRODUCT_EXISTS:([0-9a-f-]{36})/.exec(message)
  return match ? match[1] : null
}

function posCatalogueMessage(message: string): string {
  if (existingProductIdFrom(message)) {
    return 'That product already exists in the catalogue — add it to this branch instead.'
  }
  const key = Object.keys(POS_CATALOGUE_ERRORS).find((k) => message.includes(k))
  return key ? POS_CATALOGUE_ERRORS[key] : 'That did not work. Please try again.'
}

export function useAddProductToBranch() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ branchId, productId }: { branchId: string; productId: string }) => {
      const { error } = await supabase.rpc('add_pos_product_to_branch', {
        _branch_id: branchId,
        _product_id: productId,
      })
      if (error) throw new Error(posCatalogueMessage(error.message))
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: POS_CATALOGUE_KEY })
      toast.success('Added to this branch. It has no stock and is not being offered yet.')
    },
    onError: (error: Error) => toast.error(error.message),
  })
}

export function useCreateBranchProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      branchId: string
      name: string
      categoryId: string
      sellingPrice: number
    }) => {
      const { data, error } = await supabase.rpc('create_pos_product_for_branch', {
        _branch_id: input.branchId,
        _name: input.name,
        _category_id: input.categoryId,
        _selling_price: input.sellingPrice,
      })
      if (error) throw new Error(posCatalogueMessage(error.message))
      return data as unknown as string
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: POS_CATALOGUE_KEY })
      toast.success('Product created. It has no stock and is not being offered yet.')
    },
    onError: (error: Error) => toast.error(error.message),
  })
}

export function useSetBranchSellingPrice() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      branchId,
      productId,
      price,
    }: {
      branchId: string
      productId: string
      price: number | null
    }) => {
      const { error } = await supabase.rpc('set_pos_branch_selling_price', {
        _branch_id: branchId,
        _product_id: productId,
        // Null clears the override and returns this branch to the base price.
        // The generated signature types it as required; the function itself
        // accepts null and documents that meaning.
        _price: price as number,
      })
      if (error) throw new Error(posCatalogueMessage(error.message))
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: POS_CATALOGUE_KEY })
      toast.success('Price updated for this branch.')
    },
    onError: (error: Error) => toast.error(error.message),
  })
}

export function useCreatePosCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (name: string) => {
      const { data, error } = await supabase.rpc('create_pos_category', { _name: name })
      if (error) throw new Error(posCatalogueMessage(error.message))
      return data as unknown as string
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: POS_CATALOGUE_KEY })
      toast.success('Category created.')
    },
    onError: (error: Error) => toast.error(error.message),
  })
}

/**
 * Renaming a category, as a POS Manager may.
 *
 * The RPC beside create_pos_category, with the same guard --
 * `is_admin() or has_pos_role(null, ['manager'])` -- and until now nothing in
 * the app called it. A manager could already create a category from the Add
 * Product flow and then had no way to correct a typo in it.
 *
 * GLOBAL, like the taxonomy it edits. pos_product_categories carries no
 * branch_id: renaming "Drinks" renames it at every branch and on the
 * Administrator's own catalogue screen. The RPC sanctions that for a manager;
 * the dialog says so before they confirm, the way the product-rename flow
 * already does.
 *
 * Writing through the RPC rather than the table is what makes it work at all:
 * RLS on pos_product_categories is is_admin(), so useSaveCategory() -- the
 * Administrator's editor hook -- would return 42501 for a manager.
 */
export function useRenamePosCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const { error } = await supabase.rpc('rename_pos_category', {
        _category_id: id,
        _name: name,
      })
      if (error) throw new Error(posCatalogueMessage(error.message))
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: POS_CATALOGUE_KEY })
      toast.success('Category renamed everywhere it appears.')
    },
    onError: (error: Error) => toast.error(error.message),
  })
}

/**
 * Renaming or recategorising a product.
 *
 * GLOBAL. The catalogue is company-wide, so this changes the product for every
 * branch carrying it -- the screen says so before the manager confirms. The
 * function behind it can write a name and a category and nothing else, so no
 * amount of payload shaping reaches cost.
 */
export function useUpdateProductDetails() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      productId,
      name,
      categoryId,
    }: {
      productId: string
      name: string
      categoryId: string
    }) => {
      const { error } = await supabase.rpc('update_pos_product_details', {
        _product_id: productId,
        _name: name,
        _category_id: categoryId,
      })
      if (error) throw new Error(posCatalogueMessage(error.message))
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: POS_CATALOGUE_KEY })
      toast.success('Product updated for every branch that carries it.')
    },
    onError: (error: Error) => toast.error(error.message),
  })
}

/**
 * Putting a picture on a product.
 *
 * Reuses the bucket, the generated path and the validation that already
 * existed; only the row update goes through an RPC, so a manager writing an
 * image path cannot also write a cost.
 */
export function useSetProductImage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ productId, file }: { productId: string; file: File }) => {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        throw new Error('Upload a PNG, JPG or WebP image.')
      }
      if (file.size > MAX_IMAGE_BYTES) {
        throw new Error(`The image must be under ${MAX_IMAGE_BYTES / (1024 * 1024)}MB.`)
      }

      // Generated end to end: nothing the manager typed reaches the object name.
      const extension = file.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
      const path = `${productId}/${crypto.randomUUID()}.${extension}`

      const { error: uploadError } = await supabase.storage
        .from('pos-product-images')
        .upload(path, file, { contentType: file.type, upsert: false })
      if (uploadError) throw new Error('We could not upload that image. Please try again.')

      const { error } = await supabase.rpc('set_pos_product_image', {
        _product_id: productId,
        _image_path: path,
      })
      if (error) throw new Error(posCatalogueMessage(error.message))
      return path
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: POS_CATALOGUE_KEY })
      toast.success('Product image updated.')
    },
    onError: (error: Error) => toast.error(error.message),
  })
}

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const IMPORT_IMAGE_ERRORS: Record<string, string> = {
  IMAGE_URL_INVALID: 'That does not look like a valid link.',
  IMAGE_URL_SCHEME: 'Use a link starting with https://',
  // Deliberately vague about WHY. Saying "that address is internal" turns the
  // importer into a probe for what exists inside the network.
  IMAGE_URL_BLOCKED: 'That link cannot be used. Try the image address from the product page.',
  IMAGE_URL_UNREACHABLE: 'We could not reach that link. Check it opens in a browser.',
  IMAGE_URL_REDIRECTS: 'That link redirects too many times.',
  IMAGE_TYPE_UNSUPPORTED: 'That link is not a JPG, PNG or WebP image.',
  IMAGE_TOO_LARGE: 'That image is larger than 5MB.',
  IMAGE_STORE_FAILED: 'We could not save that image. Please try again.',
}

/**
 * Bring an image in from a URL.
 *
 * The browser cannot do this: a product photo on somebody else's website will
 * not send CORS headers, so fetch() from the page fails. The server can — and
 * the copy it stores is what the till renders, so the image keeps working after
 * the source site changes or disappears.
 */
export function useImportProductImage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ productId, imageUrl }: { productId: string; imageUrl: string }) => {
      const { data, error } = await supabase.functions.invoke('import-pos-product-image', {
        body: { productId, imageUrl: imageUrl.trim() },
      })

      // A non-2xx from an Edge Function arrives as an error with the body
      // attached, so the specific reason has to be dug out of the response
      // rather than read off error.message.
      if (error) {
        let code = ''
        const ctx = (error as { context?: Response }).context
        if (ctx && typeof ctx.json === 'function') {
          code = await ctx.json().then((b: { error?: string }) => b?.error ?? '').catch(() => '')
        }
        throw new Error(IMPORT_IMAGE_ERRORS[code] ?? 'We could not import that image.')
      }

      const payload = data as { error?: string; imagePath?: string } | null
      if (payload?.error) {
        throw new Error(IMPORT_IMAGE_ERRORS[payload.error] ?? 'We could not import that image.')
      }
      return payload?.imagePath ?? null
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: POS_CATALOGUE_KEY })
      toast.success('Image imported.')
    },
    onError: (error: Error) => toast.error(error.message),
  })
}
