/**
 * THE TWO MACHINES.
 *
 * A cash register dispensing banknotes and a cheque register feeding out
 * cheques, drawn inline as SVG and moved by CSS keyframes (`mm-*` in
 * `app/globals.css`). They sit on the two pages an anonymous visitor can reach,
 * `/welcome` and `/login`, and loop for as long as nobody has signed in — which
 * is the whole of the brief: "they continue moving as long as the user is not
 * able to log in."
 *
 * No JavaScript, no image asset, no icon package: a server component that
 * renders markup, animated by the stylesheet. That is why it can run on the
 * sign-in page, which has nothing to hydrate and must keep working when nothing
 * does. Every figure on a note or a cheque is decorative and says so
 * (`aria-hidden`), because a public page must not look like it is showing a
 * real amount.
 *
 * Negative animation delays start every loop part-way through, so the scene is
 * populated on the first paint instead of empty for the first few seconds.
 * `prefers-reduced-motion` stops all of it (see the stylesheet) and the picture
 * still reads.
 */

const NOTE_DRIFT: readonly { delay: string; dx: string; rot: string }[] = [
  // Spread wide enough that the notes clear the display more often than they
  // cross it; the READY read-out should be legible for most of the loop.
  { delay: '-0.2s', dx: '-58px', rot: '-16deg' },
  { delay: '-0.8s', dx: '52px', rot: '12deg' },
  { delay: '-1.4s', dx: '-14px', rot: '-5deg' },
]

const CHEQUE_DRIFT: readonly { delay: string; dx: string; rot: string }[] = [
  { delay: '-0.3s', dx: '34px', rot: '9deg' },
  { delay: '-1.1s', dx: '-22px', rot: '-7deg' },
  { delay: '-1.9s', dx: '8px', rot: '3deg' },
]

function Banknote({ delay, dx, rot }: { delay: string; dx: string; rot: string }) {
  return (
    <g
      className="mm-note"
      style={{ animationDelay: delay, ['--mm-dx' as string]: dx, ['--mm-rot' as string]: rot }}
    >
      <rect x="-30" y="-15" width="60" height="30" rx="4" fill="#CDEFD9" stroke="#166534" strokeWidth="1.5" />
      <rect x="-24" y="-9" width="48" height="18" rx="2" fill="none" stroke="#166534" strokeWidth="0.8" opacity="0.5" />
      <circle cx="0" cy="0" r="7" fill="#FFFFFF" stroke="#166534" strokeWidth="1" />
      <text x="0" y="3" textAnchor="middle" fontSize="8" fontWeight="700" fill="#166534">₱</text>
    </g>
  )
}

function Cheque({ delay, dx, rot }: { delay: string; dx: string; rot: string }) {
  return (
    <g
      className="mm-cheque"
      style={{ animationDelay: delay, ['--mm-dx' as string]: dx, ['--mm-rot' as string]: rot }}
    >
      <rect x="-50" y="-24" width="100" height="48" rx="4" fill="#FFFCF2" stroke="#B89B4E" strokeWidth="1.5" />
      <rect x="-44" y="-18" width="26" height="6" rx="1.5" fill="#E8EEF5" />
      <line x1="-44" y1="-4" x2="14" y2="-4" stroke="#1E3A5F" strokeWidth="1" opacity="0.5" />
      <line x1="-44" y1="4" x2="0" y2="4" stroke="#1E3A5F" strokeWidth="1" opacity="0.35" />
      <rect x="20" y="-10" width="24" height="12" rx="2" fill="#DFF5E8" stroke="#166534" strokeWidth="0.8" />
      <path d="M-40 16c4-6 8-6 12 0s8 6 12 0 8-6 12 0" fill="none" stroke="#1E3A5F" strokeWidth="1.2" strokeLinecap="round" opacity="0.7" />
      <text x="40" y="18" textAnchor="end" fontSize="5.5" fontWeight="700" letterSpacing="0.6" fill="#B89B4E">CHEQUE</text>
    </g>
  )
}

/**
 * The cash register. A drawer that slides open while notes rise out of it.
 * The notes are drawn before the drawer, so they emerge from behind it.
 */
export function CashRegister({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 260 250" className={`mm-bob ${className}`} role="img" aria-label="A cash register dispensing banknotes">
      <ellipse cx="130" cy="236" rx="96" ry="8" fill="#1E3A5F" opacity="0.08" />

      {/* display, on a short stalk */}
      <rect x="118" y="58" width="24" height="16" fill="#B9C8DB" />
      <rect x="62" y="24" width="136" height="42" rx="9" fill="#1E3A5F" />
      <rect x="70" y="31" width="120" height="28" rx="5" fill="#DFF5E8" />
      <text x="130" y="50" textAnchor="middle" fontFamily="ui-monospace, Menlo, Consolas, monospace" fontSize="13" fontWeight="700" letterSpacing="1.5" fill="#166534" aria-hidden="true">
        READY
      </text>
      <circle cx="184" cy="45" r="3" fill="#DFF5E8" className="mm-blink" />

      {/* body */}
      <rect x="36" y="72" width="188" height="112" rx="16" fill="#E4EBF4" stroke="#1E3A5F" strokeWidth="2" />
      <rect x="36" y="72" width="188" height="20" rx="10" fill="#1E3A5F" opacity="0.08" />

      {/* keys */}
      {[0, 1, 2, 3].map((r) =>
        [0, 1, 2, 3, 4].map((c) => (
          <rect
            key={`${r}-${c}`}
            x={54 + c * 26}
            y={100 + r * 18}
            width="20"
            height="12"
            rx="3"
            fill={(r + c) % 3 === 0 ? '#EEEBFA' : (r + c) % 3 === 1 ? '#FFFFFF' : '#E4F1FB'}
            stroke="#1E3A5F"
            strokeWidth="0.8"
            opacity="0.9"
          />
        )),
      )}
      <rect x="188" y="100" width="22" height="66" rx="5" fill="#DFF5E8" stroke="#166534" strokeWidth="1" />
      <text x="199" y="138" textAnchor="middle" fontSize="7" fontWeight="700" fill="#166534" transform="rotate(-90 199 138)" letterSpacing="1">RELEASE</text>

      {/* notes rise from behind the drawer */}
      <g transform="translate(130 196)">
        {NOTE_DRIFT.map((n) => <Banknote key={n.delay} {...n} />)}
      </g>

      {/* the drawer */}
      <g className="mm-drawer">
        <rect x="44" y="182" width="172" height="36" rx="7" fill="#FFFFFF" stroke="#1E3A5F" strokeWidth="2" />
        <rect x="56" y="192" width="148" height="16" rx="3" fill="#F6F8FC" stroke="#1E3A5F" strokeWidth="0.8" opacity="0.6" />
        <rect x="118" y="196" width="24" height="8" rx="4" fill="#1E3A5F" />
      </g>
    </svg>
  )
}

/**
 * The cheque register. A printer with a slot on top; cheques feed up through
 * it and drift away. A clip path hides whatever is still below the slot, so a
 * cheque genuinely appears to come out of the machine rather than through it.
 */
export function ChequeRegister({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 260 250" className={`mm-bob mm-bob-late ${className}`} role="img" aria-label="A cheque register dispensing cheques">
      <defs>
        <clipPath id="mm-cheque-window">
          <rect x="0" y="0" width="260" height="126" />
        </clipPath>
      </defs>

      <ellipse cx="130" cy="236" rx="96" ry="8" fill="#1E3A5F" opacity="0.08" />

      {/* paper roll at the back */}
      <rect x="92" y="96" width="76" height="30" rx="4" fill="#F6F8FC" stroke="#1E3A5F" strokeWidth="1.2" />
      <circle cx="130" cy="98" r="18" fill="#FFFCF2" stroke="#B89B4E" strokeWidth="1.5" />
      <circle cx="130" cy="98" r="5" fill="#E4EBF4" stroke="#1E3A5F" strokeWidth="1" />

      {/* cheques, revealed only above the slot */}
      <g clipPath="url(#mm-cheque-window)">
        <g transform="translate(130 100)">
          {CHEQUE_DRIFT.map((c) => <Cheque key={c.delay} {...c} />)}
        </g>
      </g>

      {/* body */}
      <rect x="36" y="122" width="188" height="86" rx="16" fill="#EEEBFA" stroke="#4C3D8F" strokeWidth="2" />
      <rect x="62" y="118" width="136" height="10" rx="3" fill="#1E3A5F" />
      <rect x="52" y="146" width="74" height="34" rx="6" fill="#FFFFFF" stroke="#4C3D8F" strokeWidth="1" opacity="0.9" />
      <text x="89" y="160" textAnchor="middle" fontSize="7" fontWeight="700" letterSpacing="1.2" fill="#4C3D8F">CHEQUE</text>
      <text x="89" y="172" textAnchor="middle" fontSize="7" fontWeight="700" letterSpacing="1.2" fill="#4C3D8F">REGISTER</text>
      <circle cx="176" cy="152" r="5" fill="#DFF5E8" stroke="#166534" strokeWidth="1" className="mm-blink" />
      <circle cx="194" cy="152" r="5" fill="#FEF3C7" stroke="#92400E" strokeWidth="1" />
      <rect x="146" y="166" width="62" height="10" rx="3" fill="#E4F1FB" stroke="#1D4E7A" strokeWidth="0.8" />
      <rect x="150" y="169" width="30" height="4" rx="2" fill="#1D4E7A" opacity="0.6" className="mm-feed" />

      {/* feet */}
      <rect x="52" y="206" width="26" height="8" rx="3" fill="#4C3D8F" opacity="0.5" />
      <rect x="182" y="206" width="26" height="8" rx="3" fill="#4C3D8F" opacity="0.5" />
    </svg>
  )
}

/** Both machines side by side, for the sign-in page's left panel. */
export function MoneyMachines({ className = '' }: { className?: string }) {
  return (
    <div className={`grid grid-cols-2 items-end gap-6 ${className}`}>
      <CashRegister className="w-full" />
      <ChequeRegister className="w-full" />
    </div>
  )
}
