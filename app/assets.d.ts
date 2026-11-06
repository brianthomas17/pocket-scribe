/** PNGs are bundled as binary data (see the "rules" in wrangler.app.jsonc). */
declare module '*.png' {
  const bytes: ArrayBuffer
  export default bytes
}
