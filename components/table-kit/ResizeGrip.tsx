'use client'

import { useRef } from 'react'
import { clampWidth } from '@/lib/table-kit/layout'

/**
 * Drag a header's right edge to size its column; double-click forgets the
 * width. Pointer capture keeps the drag alive once the pointer leaves the grip.
 */
export function ResizeGrip({ label, width, onResize }: { label: string; width?: number; onResize: (width: number | null) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null)
  return (
    <div
      role="separator" aria-orientation="vertical" aria-label={`Resize ${label}`}
      onPointerDown={(e) => {
        const th = e.currentTarget.parentElement
        drag.current = { x: e.clientX, w: width ?? th?.getBoundingClientRect().width ?? 120 }
        e.currentTarget.setPointerCapture(e.pointerId)
        e.preventDefault()
        e.stopPropagation()
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d) onResize(clampWidth(d.w + e.clientX - d.x))
      }}
      onPointerUp={() => { drag.current = null }}
      onPointerCancel={() => { drag.current = null }}
      onDoubleClick={(e) => { e.stopPropagation(); onResize(null) }}
      onClick={(e) => e.stopPropagation()}
      className="absolute right-0 top-0 h-full w-2 cursor-col-resize touch-none hover:bg-navy/20"
    />
  )
}
