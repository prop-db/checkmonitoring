import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
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
