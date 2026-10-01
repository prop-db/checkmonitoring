'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { filterHref } from '@/lib/filter-href'

/** How long the search box waits after the last keystroke. */
const DEBOUNCE_MS = 400

/**
 * The filter bar's auto-submit — an ENHANCEMENT, layered over a form that
 * already works.
 *
 * ── WHY IT IS SHAPED LIKE THIS ────────────────────────────────────────────
 * The bar is a plain `<form method="get">` and stays one. That is a real
 * property of this system, not an accident: a filtered view is linkable,
 * bookmarkable and survives a refresh, and the whole dashboard keeps working on
 * a Finance workstation whose JavaScript has failed — the same reasoning as the
 * sign-out form and the server-rendered release confirmation.
 *
 * So this component adds behaviour and removes none:
 *
 *   no script      the APPLY button submits the form natively. Unchanged.
 *   script         APPLY is hidden on mount, the dropdowns submit on change,
 *                  and the search box submits 400ms after the last keystroke.
 *
 * APPLY is hidden HERE rather than being deleted from the markup or wrapped in
 * `<noscript>`. A `<noscript>` block is only honoured when scripting is
 * DISABLED — it does nothing for the case this application actually has to
 * survive, which is scripting enabled and the bundle failing to arrive. Hiding
 * the button from a mounted effect means the button is there whenever this code
 * is not.
 *
 * The submit is intercepted rather than left to the browser because a native
 * GET submit is a full document load: on every fourth keystroke the page would
 * white out and the caret would be thrown out of the search box. `router.replace`
 * is a soft navigation — the server re-renders the table, the DOM survives, and
 * so does the cursor. `replace`, not `push`: forty keystrokes must not become
 * forty entries in the browser's history for the Back button to walk out of.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * `filterHref` builds the URL, and it is pure and tested: the URL this produces
 * has to be the URL the browser would have produced from the same form, or the
 * enhanced and unenhanced paths quietly mean different things.
 */
export function FilterAutoSubmit({ applyButtonId }: { applyButtonId: string }) {
  const router = useRouter()
  const anchor = useRef<HTMLSpanElement>(null)
  // Held in a ref, not in state: a pending timer is not something the screen
  // renders, and putting it in state would re-render the bar on every keystroke.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const form = anchor.current?.closest('form')
    if (!form) return

    const apply = document.getElementById(applyButtonId)
    // `hidden`, not `display:none` through a class: the button must be out of
    // the tab order too, or a keyboard user tabs into a control they cannot see.
    if (apply) apply.hidden = true

    const go = () => {
      if (timer.current) clearTimeout(timer.current)
      router.replace(filterHref(new FormData(form).entries()), { scroll: false })
    }

    const onSubmit = (e: SubmitEvent) => {
      e.preventDefault()
      go()
    }

    // The filter row's controls sit in the table head, outside the form
    // element, joined to it by `form=` (part C2). Their events never bubble to
    // the form, so listen on the document and keep only this form's controls.
    const owns = (t: EventTarget | null): t is HTMLInputElement | HTMLSelectElement =>
      (t instanceof HTMLInputElement || t instanceof HTMLSelectElement) && t.form === form

    const onChange = (e: Event) => {
      const t = e.target
      if (!owns(t)) return
      // A `change` on a text box fires on blur and would double-submit behind the debounce.
      if (t instanceof HTMLInputElement && t.type === 'text') return
      go()
    }

    const onInput = (e: Event) => {
      const t = e.target
      if (!owns(t) || !(t instanceof HTMLInputElement) || t.type !== 'text') return
      if (timer.current) clearTimeout(timer.current)
      // Debounced rather than fired per keystroke: "6000240287" is ten
      // round trips to Neon and ten table renders, for nine results nobody
      // reads.
      timer.current = setTimeout(go, DEBOUNCE_MS)
    }

    form.addEventListener('submit', onSubmit)
    document.addEventListener('change', onChange)
    document.addEventListener('input', onInput)

    return () => {
      if (timer.current) clearTimeout(timer.current)
      form.removeEventListener('submit', onSubmit)
      document.removeEventListener('change', onChange)
      document.removeEventListener('input', onInput)
      // Put APPLY back if this ever unmounts while the form stays: leaving a
      // form with no way to submit is worse than an extra button.
      if (apply) apply.hidden = false
    }
  }, [router, applyButtonId])

  // A zero-size marker, only so the effect can find the form it lives in
  // without the server component having to hand down a ref.
  return <span ref={anchor} hidden />
}
