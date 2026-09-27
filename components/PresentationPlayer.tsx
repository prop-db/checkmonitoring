'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * TEMPORARY — the landing page's chorus player for the 2026-09-27
 * presentation. Plays `src` (a file the user places in public/ themselves —
 * the recording is not ours to ship) and, when `start`/`end` are given, loops
 * that segment only, so a full track can be dropped in and just the chorus
 * plays. Browsers refuse to start sound without a click, hence the button.
 *
 * A client component because an <audio> element needs `play()` from a
 * gesture and a `timeupdate` listener to loop the segment. Nothing here
 * touches data. Delete with the block in app/welcome/page.tsx.
 */
export function PresentationPlayer({
  src, start = 0, end,
}: {
  src: string
  /** Seconds into the file where the chorus begins. */
  start?: number
  /** Seconds where it ends; omitted, the whole file loops. */
  end?: number
}) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    const el = audio.current
    if (!el) return
    const onTime = () => {
      if (end !== undefined && el.currentTime >= end) {
        el.currentTime = start
      }
    }
    const onError = () => { setMissing(true); setPlaying(false) }
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('error', onError)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('error', onError)
    }
  }, [start, end])

  // Start on load where the browser allows it. Chrome and Edge refuse sound
  // until the visitor has interacted with the site at least once, and a
  // refused `play()` rejects quietly — so the first click or key anywhere on
  // the page is the fallback, and on stage nobody has to find the button. A
  // missing file is a different failure and shows up through `onError`.
  useEffect(() => {
    const el = audio.current
    if (!el) return
    const start = () => {
      if (el.paused) el.play().then(() => setPlaying(true)).catch(() => undefined)
    }
    start()
    document.addEventListener('pointerdown', start)
    document.addEventListener('keydown', start)
    return () => {
      document.removeEventListener('pointerdown', start)
      document.removeEventListener('keydown', start)
    }
  }, [])

  const toggle = async () => {
    const el = audio.current
    if (!el) return
    if (playing) {
      el.pause()
      setPlaying(false)
      return
    }
    try {
      if (el.currentTime < start || (end !== undefined && el.currentTime >= end)) el.currentTime = start
      await el.play()
      setPlaying(true)
    } catch {
      setMissing(true)
    }
  }

  return (
    <div className="mt-3 flex flex-col items-center gap-1.5">
      {/* `loop` covers the no-segment case; with a segment the listener above
          seeks back before the file ever ends. */}
      <audio ref={audio} src={src} preload="auto" loop={end === undefined} />
      <button
        type="button"
        onClick={toggle}
        className="rounded-full bg-lavender-bg px-4 py-1.5 text-[11px] font-semibold tracking-[0.2em] text-lavender-ink ring-1 ring-lavender-ink/20 transition hover:bg-lavender-ink hover:text-white"
      >
        {playing ? '❚❚ PAUSE' : '▶ PLAY THE CHORUS'}
      </button>
      {missing && (
        <p className="text-[10px] text-slate-400">
          No audio yet — the clip is missing from <code>public/</code>.
        </p>
      )}
    </div>
  )
}
