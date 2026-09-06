import type { Config } from 'tailwindcss'

/**
 * The client's palette, 2026-09-06, given as hex and reproduced here exactly.
 *
 * Their note: "avoid saturated colours — the current pastel style is good." So
 * every named tone below is a pale ground with a dark ink beside it. The ink
 * for SUCCESS is the client's own (#166534); WARNING and DANGER get inks chosen
 * to sit on their grounds at the same contrast, because the brief named the
 * grounds only and a pale ground with pale text is unreadable.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // The primary. `text-navy` for the ink, `bg-navy-bg` for its pastel.
        navy: { DEFAULT: '#1E3A5F', bg: '#E8EEF5' },
        success: { bg: '#DFF5E8', ink: '#166534' },
        warning: { bg: '#FEF3C7', ink: '#92400E' },
        danger: { bg: '#FDE2E1', ink: '#9F1239' },
        // The page sits on this rather than on white, so a white card reads as
        // a raised surface instead of as more page.
        ground: '#F8FAFC',
        hairline: '#E5E7EB',
        status: {
          generated: '#EEF2F7',
          pending: '#FEF6E0',
          signed: '#E6F0FB',
          ready: '#E3F5E9',
          scheduled: '#EAF0FD',
          released: '#EDEBF7',
          cancelled: '#FAEAEA',
        },
      },
    },
  },
  plugins: [],
}

export default config
