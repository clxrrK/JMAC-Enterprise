import { Outlet, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Sidebar } from '@/components/layout/Sidebar'
import { Navbar } from '@/components/layout/Navbar'

export function DashboardLayout() {
  const location = useLocation()

  return (
    // print:block on both flex wrappers: with flex nested in flex, Chrome cut
    // printed text lines in half at the page edges. Sidebar and navbar are
    // print:hidden, so as blocks the page prints exactly as before.
    <div className="flex h-dvh overflow-hidden bg-background print:block print:h-auto print:overflow-visible">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden print:block print:overflow-visible">
        {/* No page title here — every page renders its own heading, and the
          * sidebar already marks where you are. */}
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
