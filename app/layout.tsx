import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'CHECK RELEASE MONITORING',
  description: 'Internal Finance check release monitoring system',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
