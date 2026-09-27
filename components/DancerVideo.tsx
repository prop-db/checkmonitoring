'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * TEMPORARY — the landing page's dancer for the 2026-09-27 presentation.
 *
 * Plays `src` (a clip the user placed in public/ themselves) MUTED and paints
 * it onto a canvas with the background removed LIVE, in the browser: every
 * frame goes through MediaPipe's selfie-segmentation model, whose mask is
 * drawn first and the frame composited into it (`source-in`), so only the
 * person lands on the page and the pastel ground shows through. There is no
 * ffmpeg or Python on the presenting machine, which is why the background is
 * removed at play time rather than cut out of the file once.
 *
 * The SOUND is `audioSrc` — the chorus clip the user uploaded first — and it
 * is the master clock. The two clips are different lengths (the song is
 * longer than the dance), so left to loop separately they drift apart within
 * seconds; instead the dance is seeked to the song's position every frame,
 * wrapping at its own length, and restarts with every chorus. The dance never
 * runs while the sound is stopped, and never runs ahead of it.
 *
 * The model and its WASM come from jsdelivr at first load (a few MB, cached
 * after). Until its first result the frame is drawn as-is, background and
 * all, so the space is never blank.
 *
 * Sound: the browser may refuse to start audio before the visitor has
 * interacted with the site, so playback is attempted on load AND on the
 * first click or key anywhere. A client component because all of this is
 * the browser's. Delete with the block in app/welcome/page.tsx.
 */

const MEDIAPIPE = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747'

/** How far the dance may stray from the song before it is seeked back. */
const DRIFT_TOLERANCE_SECONDS = 0.2

type SegmentationResults = { image: CanvasImageSource; segmentationMask: CanvasImageSource }
type Segmenter = {
  setOptions(o: { modelSelection: 0 | 1; selfieMode: boolean }): void
  onResults(cb: (r: SegmentationResults) => void): void
  send(input: { image: HTMLVideoElement }): Promise<void>
  close(): Promise<void>
}
type SegmenterCtor = new (cfg: { locateFile: (file: string) => string }) => Segmenter

function loadSegmenter(): Promise<SegmenterCtor | null> {
  const w = window as unknown as { SelfieSegmentation?: SegmenterCtor }
  if (w.SelfieSegmentation) return Promise.resolve(w.SelfieSegmentation)
  return new Promise((resolve) => {
    const s = document.createElement('script')
    s.src = `${MEDIAPIPE}/selfie_segmentation.js`
    s.crossOrigin = 'anonymous'
    s.onload = () => resolve(w.SelfieSegmentation ?? null)
    s.onerror = () => resolve(null)
    document.head.appendChild(s)
  })
}

export function DancerVideo({
  src, audioSrc, className = '',
}: {
  src: string
  /** The soundtrack, and the clock the dance follows. */
  audioSrc: string
  className?: string
}) {
  const video = useRef<HTMLVideoElement>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [playing, setPlaying] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'plain'>('loading')

  useEffect(() => {
    const v = video.current
    const a = audio.current
    const c = canvas.current
    if (!v || !a || !c) return
    const ctx = c.getContext('2d')
    if (!ctx) return

    let segmenter: Segmenter | null = null
    let ready = false
    // The model's WASM and weights are fetched on the FIRST `send`, not when
    // the script loads, and that takes several seconds. Until the first mask
    // comes back the frame is painted as-is, so the canvas is never blank.
    let masked = false
    let stopped = false
    let busy = false

    const fit = () => {
      if (v.videoWidth && (c.width !== v.videoWidth || c.height !== v.videoHeight)) {
        c.width = v.videoWidth
        c.height = v.videoHeight
      }
    }

    const paintPlain = () => {
      fit()
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.drawImage(v, 0, 0, c.width, c.height)
    }

    const paintMasked = (r: SegmentationResults) => {
      fit()
      ctx.save()
      ctx.clearRect(0, 0, c.width, c.height)
      // A touch of blur on the mask softens the cut edge; without it the
      // outline reads as a paper cut-out.
      ctx.filter = 'blur(2px)'
      ctx.drawImage(r.segmentationMask, 0, 0, c.width, c.height)
      ctx.filter = 'none'
      ctx.globalCompositeOperation = 'source-in'
      ctx.drawImage(r.image, 0, 0, c.width, c.height)
      ctx.restore()
      masked = true
      busy = false
    }

    /**
     * The song is the clock. The dance is where the song is, wrapped at the
     * dance's own length; when it strays past the tolerance it is seeked back.
     * A stopped song stops the dance, so a refused autoplay leaves a still
     * frame rather than a silent dancer.
     */
    const follow = () => {
      if (a.paused) {
        if (!v.paused) v.pause()
        return
      }
      if (v.paused) v.play().catch(() => undefined)
      const len = v.duration
      if (!Number.isFinite(len) || len <= 0) return
      const expected = a.currentTime % len
      if (Math.abs(v.currentTime - expected) > DRIFT_TOLERANCE_SECONDS) {
        v.currentTime = expected
      }
    }

    const frame = () => {
      if (stopped) return
      follow()
      if (v.readyState >= 2) {
        if (!v.paused && ready && segmenter && !busy) {
          busy = true
          // Not awaited: the loop must keep painting plain frames while the
          // first send is still fetching the model.
          segmenter.send({ image: v }).catch(() => { busy = false })
        }
        if (!masked) paintPlain()
      }
      requestAnimationFrame(frame)
    }

    loadSegmenter().then((Ctor) => {
      if (stopped) return
      if (!Ctor) { setStatus('plain'); return }
      segmenter = new Ctor({ locateFile: (file) => `${MEDIAPIPE}/${file}` })
      segmenter.setOptions({ modelSelection: 1, selfieMode: false })
      segmenter.onResults(paintMasked)
      ready = true
      setStatus('ready')
    })

    // `playing` follows the SOUND: the button says PLAY until the chorus is
    // actually heard, and `follow` brings the dance along.
    const start = () => {
      if (a.paused) a.play().then(() => setPlaying(true)).catch(() => undefined)
    }
    start()
    document.addEventListener('pointerdown', start)
    document.addEventListener('keydown', start)
    requestAnimationFrame(frame)

    return () => {
      stopped = true
      document.removeEventListener('pointerdown', start)
      document.removeEventListener('keydown', start)
      segmenter?.close().catch(() => undefined)
    }
  }, [])

  const toggle = () => {
    const a = audio.current
    if (!a) return
    if (a.paused) {
      a.play().then(() => setPlaying(true)).catch(() => undefined)
    } else {
      a.pause()
      setPlaying(false)
    }
  }

  return (
    <div className={`flex flex-col items-center gap-3 ${className}`}>
      {/* The video is the source only — off-screen, never shown, and muted:
          the sound is the audio element's. The canvas is what the visitor
          sees. The video does not `loop` itself; `follow` wraps it. */}
      <video ref={video} src={src} muted playsInline preload="auto" className="hidden" />
      <audio ref={audio} src={audioSrc} loop preload="auto" />
      <canvas ref={canvas} className="h-96 w-auto" aria-label="The presenter dancing" />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          className="rounded-full bg-lavender-bg px-4 py-1.5 text-[11px] font-semibold tracking-[0.2em] text-lavender-ink ring-1 ring-lavender-ink/20 transition hover:bg-lavender-ink hover:text-white"
        >
          {playing ? '❚❚ PAUSE' : '▶ PLAY'}
        </button>
        {status === 'loading' && <span className="text-[10px] tracking-wide text-slate-400">LOADING THE CUT-OUT…</span>}
        {status === 'plain' && <span className="text-[10px] tracking-wide text-slate-400">CUT-OUT UNAVAILABLE OFFLINE</span>}
      </div>
    </div>
  )
}
