import { shareImage, SHARE_SIZE } from '@/lib/brand-image'

export const alt = 'Check Release Monitoring — RCL Finance'
export const size = SHARE_SIZE
export const contentType = 'image/png'

export default function Image() {
  return shareImage()
}
