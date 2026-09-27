import type { Config } from 'tailwindcss'

/**
 * The client's palette, 2026-09-06, given as hex and reproduced here exactly.
 *
 * Their note: "avoid saturated colours — the current pastel style is good." So
 * every named tone below is a pale ground with a dark ink beside it. The ink
 * for SUCCESS is the client's own (#166534); WARNING and DANGER get inks chosen
 * to sit on their grounds at the same contrast, because the brief named the
 * grounds only and a pale ground with pale text is unreadable.
 *
 * Extended 2026-09-27 with three more pastel pairs — LAVENDER, SKY and MINT —
 * built the same way, for the landing and sign-in pages' illustrations and the
 * pipeline chips. Same rule: a pale ground, a dark ink that reads on it.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Segoe UI is what every Finance workstation here has; the rest is the
        // platform's own so the page never waits on a web font.
        sans: ['"Segoe UI"', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Roboto', 'sans-serif'],
      },
      colors: {
        // The primary. `text-navy` for the ink, `bg-navy-bg` for its pastel.
        navy: { DEFAULT: '#1E3A5F', bg: '#E8EEF5' },
        success: { bg: '#DFF5E8', ink: '#166534' },
        warning: { bg: '#FEF3C7', ink: '#92400E' },
        danger: { bg: '#FDE2E1', ink: '#9F1239' },
        lavender: { bg: '#EEEBFA', ink: '#4C3D8F' },
        sky: { bg: '#E4F1FB', ink: '#1D4E7A' },
        mint: { bg: '#E3F6F0', ink: '#0F5F4A' },
        // The page sits on this rather than on white, so a white card reads as
        // a raised surface instead of as more page. Since 2026-09-27 the body
        // paints a soft gradient over it (globals.css); this is the base.
        ground: '#F6F8FC',
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
