import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // A supplier receipt file is up to 3 MB (spec 2026-10-02); the 1 MB default
  // would refuse it before the action runs.
  experimental: { serverActions: { bodySizeLimit: '4mb' } },
}

export default nextConfig
