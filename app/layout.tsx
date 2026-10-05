import type { Metadata } from 'next'
import './globals.css'

const DESCRIPTION =
  'RCL Finance system that tracks a cheque from Acumatica to the supplier’s hands. Internal use only.'

export const metadata: Metadata = {
  metadataBase: new URL('https://checkmonitoring.rclcompanies.com'),
  title: 'CHECK RELEASE MONITORING',
  description: DESCRIPTION,
  applicationName: 'Check Release Monitoring',
  // Internal system: a preview card is wanted, a search listing is not.
  robots: { index: false, follow: false },
  openGraph: {
    type: 'website',
    siteName: 'Check Release Monitoring',
    title: 'CHECK RELEASE MONITORING',
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CHECK RELEASE MONITORING',
    description: DESCRIPTION,
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
