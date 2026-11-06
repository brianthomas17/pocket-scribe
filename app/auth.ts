/**
 * Cloudflare Access, checked again in code.
 *
 * Access stops anyone not on the list before a request reaches this Worker.
 * Verifying its token here as well means a gap in that configuration — the
 * application deleted, a route added outside it — fails closed instead of
 * serving a journal to the internet. No Access configuration at all is also a
 * refusal, never a pass.
 */

interface Jwk {
  kid: string
  kty: string
  n: string
  e: string
}

let keys: { at: number; byKid: Map<string, CryptoKey> } | null = null

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

async function signingKeys(team: string): Promise<Map<string, CryptoKey>> {
  // Access rotates its keys; an hour is well inside the rotation window.
  if (keys && Date.now() - keys.at < 60 * 60 * 1000) return keys.byKid
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`access certs → ${res.status}`)
  const { keys: list } = (await res.json()) as { keys: Jwk[] }
  const byKid = new Map<string, CryptoKey>()
  for (const k of list) {
    byKid.set(
      k.kid,
      await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    )
  }
  keys = { at: Date.now(), byKid }
  return byKid
}

export type AuthResult = { ok: true; email: string } | { ok: false; status: number; reason: string }

export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  if (env.DEV_NO_AUTH === '1' && new URL(request.url).hostname === 'localhost') return { ok: true, email: 'local' }

  const team = env.ACCESS_TEAM_DOMAIN
  const aud = env.ACCESS_AUD
  if (!team || !aud) return { ok: false, status: 503, reason: 'Access is not configured for this app' }

  const token = request.headers.get('cf-access-jwt-assertion')
  if (!token) return { ok: false, status: 403, reason: 'no Access token' }

  const [h, p, s] = token.split('.')
  if (!h || !p || !s) return { ok: false, status: 403, reason: 'malformed token' }

  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(h))) as { kid?: string; alg?: string }
    if (header.alg !== 'RS256' || !header.kid) return { ok: false, status: 403, reason: 'unexpected token type' }
    let key = (await signingKeys(team)).get(header.kid)
    if (!key) {
      // A kid we have not seen usually means Access rotated; refetch once.
      keys = null
      key = (await signingKeys(team)).get(header.kid)
    }
    if (!key) return { ok: false, status: 403, reason: 'unknown signing key' }

    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`))
    if (!valid) return { ok: false, status: 403, reason: 'bad signature' }

    const claims = JSON.parse(new TextDecoder().decode(b64url(p))) as {
      aud?: string | string[]
      exp?: number
      iss?: string
      email?: string
    }
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!auds.includes(aud)) return { ok: false, status: 403, reason: 'token is for another application' }
    if (!claims.exp || claims.exp * 1000 < Date.now()) return { ok: false, status: 403, reason: 'expired' }
    if (claims.iss !== `https://${team}`) return { ok: false, status: 403, reason: 'wrong issuer' }
    return { ok: true, email: claims.email ?? '' }
  } catch (err) {
    return { ok: false, status: 403, reason: `token check failed: ${err instanceof Error ? err.message : err}` }
  }
}
