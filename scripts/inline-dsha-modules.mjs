#!/usr/bin/env node
/**
 * Inline the two DSHA-new modules into lib/index.js.
 *
 * DSHA's runtime plugin directory is populated from a FIXED manifest derived
 * from the upstream 2.4.0 build (lib/client.js, index.js, compress.js,
 * delete-session.js). New module files added by 2.5.x (route-guard.js,
 * token-usage.js) are never copied there, so any import of them fails at
 * startup with ERR_MODULE_NOT_FOUND (`file:///root/dsha-web-mobile/lib/
 * token-usage.js`). Both modules are self-contained (zero imports), so they
 * can be inlined verbatim into the one file DSHA does ship.
 *
 * Run AFTER `npm run build`, BEFORE packing the APK.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

/** Read a module and strip the `export ` keyword so it inlines as local decls. */
async function readInlined(name) {
  const src = await readFile(join(libDir, name), 'utf8')
  return src
    .replace(/^export\s+/gm, '')
    .replace(/\/\/# sourceMappingURL=.*$/m, '')
    .trim()
}

const index = await readFile(join(libDir, 'index.js'), 'utf8')

const importsToDrop = [
  /^import\s*\{[^}]*\}\s*from\s*'\.\/route-guard\.js';?\s*$/m,
  /^import\s*\{[^}]*\}\s*from\s*'\.\/token-usage\.js';?\s*$/m,
]

let body = index
for (const re of importsToDrop) {
  if (!re.test(body)) {
    throw new Error(`expected import not found in index.js: ${re}`)
  }
  body = body.replace(re, '')
}

const routeGuard = await readInlined('route-guard.js')
const tokenUsage = await readInlined('token-usage.js')

const banner =
  '// ── inlined: route-guard.js + token-usage.js (DSHA ships a fixed lib\n' +
  '// manifest; these modules must live inside index.js or the host cannot\n' +
  '// resolve them at startup) ──\n'

const out = banner + routeGuard + '\n\n' + tokenUsage + '\n' + body
await writeFile(join(libDir, 'index.js'), out, 'utf8')

// The inlined modules must not remain as separate files: DSHA would ignore
// them anyway, and keeping them risks a stale shadow copy in local dev.
console.log('inlined route-guard.js and token-usage.js into lib/index.js')
console.log('index.js bytes:', Buffer.byteLength(out, 'utf8'))