# Deployment — installers + auto-update

SoqlForge ships as a Windows installer built entirely by **Tauri's own
bundler** (NSIS `.exe` + MSI). Auto-update is handled by the **Tauri updater
plugin**, which pulls signed releases from **GitHub Releases**. No third-party
installer tooling or license is required.

There are two paths:

- **CI release (the real one)** — push a `v*` tag; GitHub Actions builds the
  signed installers, generates the updater manifest, and publishes a Release.
  Installed apps then update themselves.
- **Local build** — `scripts/release.ps1` produces the same installers on your
  machine for a quick test. These are unsigned unless you export the signing
  env vars, so they can't drive auto-update — that's what CI is for.

---

## One-time setup: the updater signing key

Tauri's updater refuses any download that isn't signed by *your* key. You
generate a keypair once. The **private** key is a secret; the **public** key
ships in the app.

```powershell
# Generates a keypair. You'll be prompted for a password — remember it.
npx tauri signer generate -w soqlforge.key
```

This writes `soqlforge.key` (private) and `soqlforge.key.pub` (public).
`*.key` / `*.key.pub` are git-ignored — **do not commit them.**

Then:

1. **Public key** → paste the contents of `soqlforge.key.pub` into
   [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json) at
   `plugins.updater.pubkey`, replacing `REPLACE_WITH_UPDATER_PUBLIC_KEY`.
   Commit that change.
2. **Private key** → add two repository secrets in GitHub
   (**Settings → Secrets and variables → Actions**):
   - `TAURI_SIGNING_PRIVATE_KEY` — the full contents of `soqlforge.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you chose
3. Store `soqlforge.key` + its password somewhere safe (a password manager).
   If you lose it, existing installs can no longer auto-update to any build
   signed with a *new* key — they'd need a manual reinstall.

> **Keep the same key for the life of the product.** Rotating it breaks the
> update path for everyone already on an old version.

---

## Cutting a release

The app version in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json)
(`version`) is the single source of truth. Bump it, commit, then tag:

```powershell
git tag v0.2.0
git push origin v0.2.0
```

That triggers [`.github/workflows/release.yml`](.github/workflows/release.yml),
which:

1. Builds the release (Rust + Vite) on `windows-latest`.
2. Bundles the NSIS `.exe` and MSI installers.
3. Signs the updater artifacts with your private key and emits `latest.json`.
4. Creates a GitHub Release named `SoqlForge v0.2.0` and uploads the
   installers + `latest.json` as assets.

The tag and the `version` field should match (`v0.2.0` ↔ `0.2.0`).

---

## How auto-update works

- The app is configured (in `tauri.conf.json → plugins.updater`) to poll:
  ```
  https://github.com/Ask-The-Forge/SoqlForge/releases/latest/download/latest.json
  ```
  That URL always resolves to the newest release's manifest.
- On startup the frontend calls the updater once
  ([`src/hooks/useUpdater.ts`](src/hooks/useUpdater.ts)). If a newer signed
  version exists, a subtle **"Update to X available"** prompt appears in the
  status bar. Nothing downloads until the user clicks it.
- On click: the plugin downloads the new installer, verifies its signature
  against the embedded public key, installs it (`passive` mode — a small
  progress UI, no wizard clicks), and relaunches into the new version.

A failed or unreachable check never disrupts the app — it just stays silent.

---

## Local test build (no release)

```powershell
# PowerShell 7:
pwsh scripts/release.ps1
# Windows PowerShell 5.1:
powershell -ExecutionPolicy Bypass -File scripts/release.ps1

# Bump the version at the same time:
pwsh scripts/release.ps1 -Version 0.2.0
```

Installers land in `dist-release/<version>/{nsis,msi}/`. These are for local
testing; they're unsigned (unless you set `TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in your shell first) and won't be accepted
by the auto-updater.

---

## Code signing the installer (optional)

The updater signature above authenticates *updates*; it is separate from
**Authenticode**, which is what silences Windows SmartScreen on first install.
They're independent — the updater works without Authenticode.

If you have a code-signing certificate, point Tauri at it via
`bundle.windows.signCommand` (or the `certificateThumbprint` /
`signingIdentity` options) in `tauri.conf.json`. An EV certificate clears
SmartScreen immediately; a standard OV cert builds reputation over time.
Without one, users get a dismissable SmartScreen warning on the first install
only.

---

## Prerequisites (build machine / CI)

- Node 18+ (`npm`)
- Rust + cargo via `rustup`
- Visual Studio Build Tools 2019+ (C++ workload)
- WebView2 runtime — ships with Windows 10 1809+; Tauri's NSIS installer
  downloads it automatically on older boxes.

---

## Quick reference

| Thing | Where it lives |
| --- | --- |
| App version (source of truth) | `src-tauri/tauri.conf.json` → `version` |
| Updater config (endpoint + pubkey) | `src-tauri/tauri.conf.json` → `plugins.updater` |
| Update check (frontend) | `src/hooks/useUpdater.ts` |
| Release workflow | `.github/workflows/release.yml` |
| Local build script | `scripts/release.ps1` |
| Signing key secrets | GitHub repo → Settings → Secrets → Actions |
| Published installers + `latest.json` | GitHub Releases |

---

## Troubleshooting

- **CI release fails at the bundling step with a signing error.** The
  `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` secrets are missing or wrong, or
  `plugins.updater.pubkey` is still the placeholder. Regenerate/re-paste per
  the setup section.
- **App never sees an update.** Confirm the new release is *published* (not a
  draft) and that its `latest.json` lists a version strictly higher than the
  installed one. The endpoint resolves to `releases/latest/download/…`, so a
  draft release won't be picked up.
- **"Signature verification failed" on download.** The public key in
  `tauri.conf.json` doesn't match the private key CI signed with. They must be
  the same pair.
- **SmartScreen warning on first install.** Expected for an unsigned (no
  Authenticode) installer — dismiss it, or add a code-signing cert (above).
