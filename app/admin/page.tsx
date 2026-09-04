import { redirect } from 'next/navigation'

// /admin has no content of its own. Without this it is a 404 rendered inside a
// layout that shows four working tabs, which reads as a broken page rather
// than as a route that was never meant to be visited.
export default function AdminIndexPage() {
  redirect('/admin/sync')
}
