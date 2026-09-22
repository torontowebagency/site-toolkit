#!/usr/bin/env node
/**
 * site-verify — checks a built static site before it is allowed to go live.
 *
 * Runs identically in three places — a developer's terminal, GitHub Actions,
 * and the Cloudflare Pages build — so a failure is always reproducible locally.
 * When it exits non-zero during a Pages build, the deploy is abandoned and the
 * previous version keeps serving.
 *
 * Nothing here is a wall. Every blocking check can be waved through, because
 * the person shipping owns the site and gets the final say. The point is to
 * make breakage *deliberate* rather than accidental.
 *
 * Severities
 *   error → blocks the deploy (overridable)
 *   warn  → printed, never blocks
 *
 * Overrides, in the two places you might be able to reach:
 *   VERIFY_ALLOW=render,media-missing      env var — local runs and CI inputs
 *   verify-allow: render                   commit message trailer — the only
 *                                          channel a Pages build can see, and
 *                                          so the only one that unblocks a deploy
 *
 * Configuration lives in the consuming site's `site.json` under `verify`; every
 * field has a default, so a new site usually needs none of it.
 *
 * Failure messages are written for whoever caused the failure — frequently an
 * AI agent with no access to this file. Say what broke, where, and what to do.
 */
import { createServer } from 'node:http'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'

const execFileAsync = promisify(execFile)

/* ------------------------------------------------------------------ config */

const ROOT = process.env.VERIFY_ROOT ? resolve(process.env.VERIFY_ROOT) : process.cwd()

const readJson = (p, fallback = null) => {
  try {
    return JSON.parse(readFileSync(join(ROOT, p), 'utf8'))
  } catch {
    return fallback
  }
}

const site = readJson('site.json', {}) ?? {}
const cfg = {
  distDir: 'dist',
  contentFile: 'content.json',
  mediaDir: 'public/media',
  mediaUrlPrefix: '/media/',
  entryHtml: 'index.html',
  rootSelector: '<div id="root">',
  minRenderBytes: 5000,
  /** null = do not check. An array = the only runtime deps permitted. */
  allowedDependencies: null,
  /** Scripts in the source HTML that are expected and therefore not flagged. */
  allowedScriptSrc: ['/src/main.tsx'],
  /** Per-check severity overrides, e.g. { "media-unreferenced": "error" }. */
  severity: {},
  ...(site.verify ?? {}),
}

/**
 * Whether each check blocks. A site can retune any of these in site.json under
 * `verify.severity` without touching the toolkit — what is worth stopping a
 * deploy for is a per-site judgement, not a universal truth.
 */
const DEFAULT_SEVERITY = {
  'build-placeholders': 'error',
  'media-missing': 'error',
  'media-filenames': 'error',
  'dependency-added': 'error',
  'inline-script': 'error',
  'media-overwritten': 'error',
  'media-unreferenced': 'warn',
  'render': 'error',
  'render-skipped': 'warn',
}
const severityOf = (id) => cfg.severity[id] ?? DEFAULT_SEVERITY[id] ?? 'error'

const DIST = join(ROOT, cfg.distDir)
const MEDIA_DIR = join(ROOT, cfg.mediaDir)

/* --------------------------------------------------------------- overrides */

function commitAllowList() {
  try {
    const msg = execFileSync('git', ['log', '-1', '--format=%B'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = msg.match(/^\s*verify-allow\s*:\s*(.+)$/im)
    return m ? m[1] : ''
  } catch {
    return '' // no git history (shallow clone, tarball) — env var still works
  }
}

const ALLOW = new Set(
  [process.env.VERIFY_ALLOW ?? '', commitAllowList()]
    .join(',')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)
const allowed = (id) => ALLOW.has('all') || ALLOW.has(id)

/* --------------------------------------------------------------- reporting */

const RESET = '\x1b[0m'
const C = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m' }
const color = (c, s) => (process.stdout.isTTY || process.env.CI ? `${C[c]}${s}${RESET}` : s)

const results = []
// Printed as each check finishes rather than buffered to the end: if a check
// hangs, the output stops exactly where the problem is.
const emit = (r) => {
  results.push(r)
  if (r.level === 'pass') console.log(`  ${color('green', '✓')} ${color('dim', r.msg)}`)
  else if (r.level === 'warn')
    console.log(`  ${color('yellow', '⚠')} ${r.msg}${r.overridden ? color('dim', ' (waved through)') : ''}`)
  else console.log(`  ${color('red', '✗')} ${r.msg}`)
}
const pass = (msg) => emit({ level: 'pass', msg })
/** Report a problem at its configured severity, downgraded if waved through. */
const problem = (id, msg, detail) => {
  const base = severityOf(id)
  const level = base === 'error' && allowed(id) ? 'warn' : base
  emit({ level, id, msg, detail, overridden: base === 'error' && allowed(id) })
}
const warn = problem
const fail = problem

/* ----------------------------------------------------------------- helpers */

/** Every string value in a JSON tree, with a readable path to each. */
function* walkStrings(node, path = '') {
  if (typeof node === 'string') yield [path, node]
  else if (Array.isArray(node)) for (const [i, v] of node.entries()) yield* walkStrings(v, `${path}[${i}]`)
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) yield* walkStrings(v, path ? `${path}.${k}` : k)
}

function findChrome() {
  return [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean).find((p) => existsSync(p)) ?? null
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

function serveDist() {
  const server = createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (p.endsWith('/')) p += 'index.html'
    const file = join(DIST, p)
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)))
}

/* ------------------------------------------------------------------ checks */

console.log(`\n${color('bold', `Verifying ${cfg.distDir}/`)}\n`)

if (!existsSync(DIST)) {
  console.error(color('red', `\n✗ ${cfg.distDir}/ does not exist — build the site first.\n`))
  process.exit(1)
}

const distHtml = readFileSync(join(DIST, 'index.html'), 'utf8')
const srcHtml = existsSync(join(ROOT, cfg.entryHtml)) ? readFileSync(join(ROOT, cfg.entryHtml), 'utf8') : ''
const content = readJson(cfg.contentFile)
const pkg = readJson('package.json', {}) ?? {}
const mediaFiles = existsSync(MEDIA_DIR) ? readdirSync(MEDIA_DIR).filter((f) => !f.startsWith('.')) : []

// 1 — the build actually ran and substituted its placeholders
{
  const left = distHtml.match(/%[A-Z_]+%/g)
  if (left) {
    fail(
      'build-placeholders',
      `${cfg.distDir}/index.html still contains ${left.length} unsubstituted placeholder(s): ${[...new Set(left)].join(', ')}`,
      '  The site was published without being built — the output is raw source.\n' +
        '  The host\'s build command is probably missing or wrong.',
    )
  } else pass('no unresolved build placeholders')
}

// 2 — every media reference in the content file exists on disk
if (content) {
  const present = new Set(mediaFiles)
  const missing = []
  let refs = 0
  for (const [path, value] of walkStrings(content)) {
    if (!value.startsWith(cfg.mediaUrlPrefix)) continue
    refs++
    const name = value.slice(cfg.mediaUrlPrefix.length)
    if (!present.has(name)) missing.push({ path, value })
  }
  if (missing.length) {
    fail(
      'media-missing',
      `${missing.length} image(s) referenced by ${cfg.contentFile} do not exist`,
      missing.map((m) => `  ${cfg.contentFile} → ${m.path}\n    references ${m.value}  (no such file)`).join('\n') +
        `\n\n  Files present in ${cfg.mediaDir}/:\n    ${[...present].sort().join(', ') || '(none)'}` +
        `\n\n  Fix: add the file, or correct the path in ${cfg.contentFile}.`,
    )
  } else pass(`media references resolve (${refs}/${refs})`)
}

// 3 — media filenames stay URL-safe
{
  const bad = mediaFiles.filter((f) => /[^a-z0-9._-]/.test(f))
  if (bad.length) {
    fail(
      'media-filenames',
      `${bad.length} media filename(s) are not URL-safe: ${bad.join(', ')}`,
      '  Use lowercase letters, digits, dots, hyphens, underscores. Spaces and parentheses\n' +
        '  break on some CDNs and in some email clients. Rename the file and update the\n' +
        '  reference to it.',
    )
  } else pass('media filenames are URL-safe')
}

// 4 — runtime dependency allowlist (skipped unless the site configures one)
if (Array.isArray(cfg.allowedDependencies)) {
  const permitted = new Set(cfg.allowedDependencies)
  const added = Object.keys(pkg.dependencies ?? {}).filter((d) => !permitted.has(d))
  if (added.length) {
    fail(
      'dependency-added',
      `package.json has runtime dependencies outside the allowlist: ${added.join(', ')}`,
      '  Every runtime dependency ends up in the browser bundle of a live business site.\n' +
        '  If this one is wanted, add it to `verify.allowedDependencies` in site.json in\n' +
        '  the same change, so the allowlist stays an explicit decision.',
    )
  } else pass('dependencies match allowlist')
}

// 5 — no hand-written script tags in the source HTML
if (srcHtml) {
  const unexpected = [...srcHtml.matchAll(/<script\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((s) => !cfg.allowedScriptSrc.some((ok) => s.includes(ok)))
  if (unexpected.length) {
    fail(
      'inline-script',
      `${cfg.entryHtml} contains ${unexpected.length} hand-written <script> tag(s)`,
      unexpected.map((s) => `    ${s}`).join('\n') +
        '\n\n  Third-party tags belong in site.json under `analytics`, rendered at build time.\n' +
        '  Hand-written tags are easy to duplicate, hard to audit, and invisible to review.',
    )
  } else pass('no hand-written script tags')
}

// 6 — media present but unreferenced (warning: usually leftovers)
if (content) {
  const referenced = new Set(
    [...walkStrings(content)]
      .filter(([, v]) => v.startsWith(cfg.mediaUrlPrefix))
      .map(([, v]) => v.slice(cfg.mediaUrlPrefix.length)),
  )
  const orphans = mediaFiles.filter((f) => !referenced.has(f))
  if (orphans.length) {
    warn(
      'media-unreferenced',
      `${orphans.length} file(s) in ${cfg.mediaDir}/ are not referenced by ${cfg.contentFile}`,
      `    ${orphans.join(', ')}\n\n  Not an error. Delete them if they are no longer needed.`,
    )
  } else pass('no unreferenced media')
}

// 7 — a photo replaced in place rather than added (warning: cache staleness)
{
  try {
    const base = process.env.VERIFY_DIFF_BASE || 'HEAD~1'
    const out = execFileSync('git', ['diff', '--name-status', base, 'HEAD', '--', cfg.mediaDir], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const modified = out.split('\n').filter((l) => l.startsWith('M')).map((l) => l.split('\t')[1])
    if (modified.length) {
      warn(
        'media-overwritten',
        `${modified.length} photo(s) were replaced in place rather than added under a new name`,
        `    ${modified.join('\n    ')}\n\n` +
          '  Browsers and the CDN key their caches on the URL, so an overwritten file can keep\n' +
          '  showing the OLD image to visitors for hours after this repo is correct. Adding a\n' +
          '  new filename and repointing the content avoids that entirely — a new URL is never\n' +
          '  stale. If you meant to overwrite, this warning is safe to ignore.',
      )
    } else pass('no photos replaced in place')
  } catch {
    // Shallow clone or no history — skip rather than fail.
  }
}

// 8 — the page actually renders (the check that earns the others)
{
  const chrome = findChrome()
  if (!chrome) {
    warn(
      'render-skipped',
      'render check skipped — no Chrome found',
      '  Set CHROME_PATH, or install Google Chrome / Chromium.\n' +
        '  This is the check that catches a green build serving a blank page, so it should\n' +
        '  not stay skipped in CI.',
    )
  } else {
    const server = await serveDist()
    const { port } = server.address()
    try {
      // MUST be async. execFileSync blocks the event loop, which would stop the
      // server above from ever answering Chrome — a deadlock, not a slow page.
      const { stdout: dom } = await execFileAsync(
        chrome,
        // Plain --headless only. Both --headless=new and --user-data-dir make
        // --dump-dom hang indefinitely (measured, Chrome 14x, macOS + Linux).
        ['--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
         '--dump-dom', '--virtual-time-budget=9000', `http://127.0.0.1:${port}/`],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 60_000, killSignal: 'SIGKILL' },
      )
      const i = dom.indexOf(cfg.rootSelector)
      const inner = i === -1 ? '' : dom.slice(i + cfg.rootSelector.length, dom.lastIndexOf('</div>'))
      if (inner.length < cfg.minRenderBytes) {
        fail(
          'render',
          `the page does not render — the app root contains ${inner.length} bytes (working pages are tens of thousands)`,
          '  The build succeeded, so this is a RUNTIME error. Nothing in a build log or a\n' +
            '  code diff will show it — the site would go live completely blank.\n\n' +
            '  Reproduce locally:\n' +
            '    build the site, serve it, open it, and read the browser console.\n\n' +
            '  Most common cause: something throwing at module load, or the content file no\n' +
            '  longer matching the shape the components expect.',
        )
      } else pass(`page renders (${inner.length.toLocaleString()} bytes in the app root)`)
    } catch (err) {
      fail(
        'render',
        err.killed || err.signal
          ? 'render check timed out — Chrome did not return a DOM within 60s'
          : `render check could not run: ${String(err.message).split('\n')[0]}`,
        '  This is a tooling failure, not necessarily a broken page. Serve the built site\n' +
          '  and look at it. If it is fine, wave this check through with `verify-allow: render`.',
      )
    } finally {
      server.close()
    }
  }
}

/* ------------------------------------------------------------------ report */

for (const r of results) {
  if (r.level !== 'pass' && r.detail) {
    const mark = r.level === 'error' ? color('red', '✗') : color('yellow', '⚠')
    console.log(`\n${mark} ${r.msg}  ${color('dim', `[${r.id}]`)}`)
    console.log(r.detail.replace(/^/gm, '  '))
  }
}

const errors = results.filter((r) => r.level === 'error')
const warnings = results.filter((r) => r.level === 'warn')
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

console.log('')
if (!errors.length) {
  console.log(color('green', `0 errors, ${plural(warnings.length, 'warning')} — OK to deploy\n`))
  process.exit(0)
}

const ids = errors.map((e) => e.id).join(',')
console.log(color('red', `${plural(errors.length, 'error')}, ${plural(warnings.length, 'warning')} — deploy blocked`))
console.log(color('dim', `
This is a stop, not a wall. It is your site — if you want this live anyway, add a
trailer to the commit message and push again:

    verify-allow: ${ids}

for example:

    git commit -m "Update the hero photo

    verify-allow: ${ids}
    Looked at it by hand, the page is fine."

That deploys it. The trailer applies to that commit only, so the check is back on
for the next one — there is no permanent off switch to forget about.

To skip the check on a local run instead:  VERIFY_ALLOW=${ids}
`))
process.exit(1)
