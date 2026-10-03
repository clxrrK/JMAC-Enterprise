import { Outlet, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { PosSidebar } from '@/components/layout/PosSidebar'
import { Navbar } from '@/components/layout/Navbar'

/** The POS portal shell. Deliberately the same shape as DashboardLayout -- same
 * Navbar, same content framing -- so the two portals feel like one system,
 * while the sidebar beside it is entirely separate. */
export function PosLayout() {
  const location = useLocation()

  return (
    // print:block on both flex wrappers, as in DashboardLayout: nested flex
    // made Chrome cut printed text lines in half at the page edges.
    <div className="flex h-dvh overflow-hidden bg-background print:block print:h-auto print:overflow-visible">
      <PosSidebar />
      <div className="flex flex-1 flex-col overflow-hidden print:block print:overflow-visible">
        <Navbar />
        <main className="flex-1 overflow-y-auto p-6 print:overflow-visible print:p-0">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="mx-auto max-w-6xl"
          >
            <Outlet />
          </motion.div>
        </main>
      </div>
    </div>
  )
}
