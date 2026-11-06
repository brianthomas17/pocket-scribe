/**
 * What a phone needs to put the app on its home screen: a web app manifest
 * (Android, and the name everywhere) and PNG icons (iOS ignores the manifest's
 * icons and asks for apple-touch-icon). Served by the app Worker, behind the
 * same Access login as everything else — the browser adding the icon is the
 * one already signed in.
 */

import icon180 from './icons/icon-180.png'
import icon192 from './icons/icon-192.png'
import icon512 from './icons/icon-512.png'

const BACKGROUND = '#f6efe2'

const manifest = {
  name: 'Pocket Scribe',
  short_name: 'Scribe',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: BACKGROUND,
  theme_color: BACKGROUND,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  ],
}

const png = (bytes: ArrayBuffer) =>
  new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' } })

/** A response for a home-screen asset path, or null for anything else. */
export function homeScreenAsset(pathname: string): Response | null {
  switch (pathname) {
    case '/manifest.webmanifest':
      return new Response(JSON.stringify(manifest), {
        headers: { 'content-type': 'application/manifest+json', 'cache-control': 'private, max-age=3600' },
      })
    case '/apple-touch-icon.png':
      return png(icon180)
    case '/icon-192.png':
      return png(icon192)
    case '/icon-512.png':
      return png(icon512)
    default:
      return null
  }
}

/** Tags for every page's <head>. */
export const HOME_SCREEN_HEAD = [
  '<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  '<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="Scribe">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
  `<meta name="theme-color" content="${BACKGROUND}" media="(prefers-color-scheme: light)">`,
  '<meta name="theme-color" content="#141312" media="(prefers-color-scheme: dark)">',
].join('')
