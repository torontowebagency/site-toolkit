# site-toolkit

Shared pre-deploy verification for Toronto Web Agency client sites.

Client sites are static bundles that anyone — a person or an AI agent — can push to.
This checks a built site before it is allowed to replace the live one, so the common
ways to break a site accidentally are caught, and the uncommon ones stay possible on
purpose.

## Why it lives here and not in each site

The verifier is the same everywhere, so a fix lands once rather than in N repos. Two
real bugs in it were found within an hour of writing it (a deadlock between the test
server and a synchronous subprocess call; Chrome flags that make `--dump-dom` hang). If
that script had been copied into every client repo, fixing those would mean editing
every repo and hoping none were missed.

## Install

```json
{
  "devDependencies": {
    "@torontowebagency/site-toolkit": "github:torontowebagency/site-toolkit#v1"
  },
  "scripts": {
    "verify:dist": "site-verify",
    "ci:build": "pnpm typecheck && pnpm build && pnpm verify:dist"
  }
}
```

The tag pins the major version; the lockfile pins the exact commit, so a change here
never reaches a live site until that site runs `pnpm update`.

Point the host's build command at `pnpm ci:build`. On Cloudflare Pages a failed build
is abandoned and the previous deployment keeps serving — that is what makes this a gate
rather than a report.

## Checks

| id | Default | Catches |
|---|---|---|
| `render` | **error** | A green build that serves a blank page |
| `build-placeholders` | **error** | Raw source published without being built |
| `media-missing` | **error** | Content referencing an image that is not there |
| `media-filenames` | **error** | Spaces or parentheses that break on some CDNs |
| `media-overwritten` | **error** | A photo replaced in place — caches keep serving the old one |
| `dependency-added` | **error** | A runtime dependency outside the allowlist |
| `inline-script` | **error** | Hand-written `<script>` tags instead of declared analytics |
| `media-unreferenced` | warn | Leftover files nothing points at |
| `render-skipped` | warn | No Chrome available to run the render check |

`render` is the one that earns the rest. A blank page passes typecheck, passes the
build, and looks fine in every log — only loading it catches it.

## Waving a check through

Nothing here is a wall. The site belongs to whoever is shipping, and they get the last
word; the point is to make breakage deliberate rather than accidental.

**In a commit message** — the only channel a Cloudflare Pages build can see, so the only
one that unblocks a deploy:

```
Swap the hero photo

verify-allow: media-overwritten
Same crop, replacing it on purpose.
```

**As an environment variable** — for local runs and CI inputs:

```bash
VERIFY_ALLOW=render,media-missing site-verify
```

Either accepts several comma-separated ids, or `all`. A commit trailer applies to that
commit only, so there is no permanent off switch to forget about.

## Configuration

Optional, in the consuming site's `site.json`. Every field has a default.

```json
{
  "verify": {
    "distDir": "dist",
    "contentFile": "content.json",
    "mediaDir": "public/media",
    "mediaUrlPrefix": "/media/",
    "rootSelector": "<div id=\"root\">",
    "minRenderBytes": 5000,
    "allowedDependencies": ["react", "react-dom"],
    "severity": { "media-unreferenced": "error" }
  }
}
```

`allowedDependencies` is `null` by default, which skips that check entirely. `severity`
retunes any check — what is worth stopping a deploy for is a per-site judgement.

## Requirements

Node 20+, and Chrome or Chromium for the render check (set `CHROME_PATH` if it is
somewhere unusual). GitHub-hosted Ubuntu runners have it at
`/usr/bin/google-chrome`. No npm dependencies.
