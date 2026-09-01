import argon2 from 'argon2'

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id })
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    return false
  }
}

const MIN_LENGTH = 12

export function validatePasswordStrength(plain: string): { ok: true } | { ok: false; message: string } {
  if (plain.length < MIN_LENGTH) {
    return { ok: false, message: `Password must be at least ${MIN_LENGTH} characters.` }
  }
  const checks: [RegExp, string][] = [
    [/[a-z]/, 'a lowercase letter'],
    [/[A-Z]/, 'an uppercase letter'],
    [/[0-9]/, 'a digit'],
    // Excludes whitespace: a bare space is not a symbol for policy purposes.
    [/[^A-Za-z0-9\s]/, 'a symbol'],
  ]
  const missing = checks.filter(([re]) => !re.test(plain)).map(([, label]) => label)
  if (missing.length) {
    return { ok: false, message: `Password must contain ${missing.join(', ')}.` }
  }
  return { ok: true }
}
