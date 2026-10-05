import { ImageResponse } from 'next/og'

/**
 * The share-preview card and the touch icon, drawn once. Both are served to
 * people who are not signed in (a link pasted into a chat is fetched by the
 * chat's crawler), so they carry the name and nothing else — no figure, no
 * vendor, no cheque.
 */

const GREEN = '#0f3d2e'
const PAPER = '#f6f1e1'
const TICK = '#1f9d6b'

function Mark({ size }: { size: number }) {
  const s = size / 64
  return (
    <div
      style={{
        width: size,
        height: size,
        background: GREEN,
        borderRadius: 14 * s,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 48 * s,
          height: 32 * s,
          background: PAPER,
          borderRadius: 4 * s,
          display: 'flex',
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 26 * s,
            top: 3 * s,
            width: 20 * s,
            height: 20 * s,
            borderRadius: 10 * s,
            background: TICK,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: 14 * s,
            fontWeight: 800,
          }}
        >
          ✓
        </div>
      </div>
    </div>
  )
}

export const SHARE_SIZE = { width: 1200, height: 630 }

export function shareImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: GREEN,
          display: 'flex',
          alignItems: 'center',
          padding: 90,
          gap: 60,
          color: PAPER,
        }}
      >
        <Mark size={240} />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.05 }}>CHECK RELEASE</div>
          <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.05 }}>MONITORING</div>
          <div style={{ fontSize: 30, marginTop: 28, color: '#9fd8bd' }}>
            From Acumatica to the supplier&apos;s hands
          </div>
          <div style={{ fontSize: 24, marginTop: 10, opacity: 0.7 }}>RCL Finance · Internal use only</div>
        </div>
      </div>
    ),
    SHARE_SIZE,
  )
}

export function touchIcon() {
  return new ImageResponse(<Mark size={180} />, { width: 180, height: 180 })
}
