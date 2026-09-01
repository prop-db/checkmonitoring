// The business runs on Philippine time. Set TZ before any module that reads
// dates is imported, so every server-side "today" is Manila-local.
export async function register() {
  process.env.TZ = process.env.TZ || 'Asia/Manila'
}
