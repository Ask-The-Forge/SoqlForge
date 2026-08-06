# Deployment — installers + auto-update

SoqlForge ships for **Windows** (NSIS `.exe` + MSI) and **macOS** (`.dmg`, one
per architecture), built entirely by **Tauri's own bundler**. Auto-update is
handled by the **Tauri updater plugin**, which pulls signed releases from
**GitHub Releases**. No third-party installer tooling or license is required.

There are two paths:

- **CI release (the real one)** — push a `v*` tag; GitHub Actions builds the
  signed installers for every platform, generates the updater manifest, and
  publishes a Release. Installed apps then update themselves.
- **Local build** — `scripts/release.ps1` (Windows) / `scripts/release.sh`
  (macOS) produces the same artifacts on your machine for a quick test. These
  are unsigned unless you export the signing env vars, so they can't drive
  auto-update — that's what CI is for.

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
which walks a three-entry build matrix — `windows-latest`, and `macos-latest`
targeting both `aarch64-apple-darwin` and `x86_64-apple-darwin` — and for each:

1. Builds the release (Rust + Vite).
2. Bundles the platform's artifacts (NSIS `.exe` + MSI on Windows, `.dmg` on
   macOS).
3. Signs the updater artifacts with your private key and merges that platform
   into `latest.json`.
4. Appends everything to a **draft** GitHub Release named `SoqlForge v0.2.0`.

A final `publish` job flips the draft to published once all three have landed.

The tag and the `version` field should match (`v0.2.0` ↔ `0.2.0`).

> **Why the matrix runs one job at a time.** Each job merges its platform into
> the shared `latest.json` by downloading the asset, adding its entry, and
> re-uploading. Run them in parallel and two jobs read the same base — the
> loser's platform silently disappears from the manifest, and those users stop
> being offered updates. `max-parallel: 1` costs a few minutes and removes the
> race entirely. Keeping the release a draft until the end is the matching
> guarantee on the read side: the updater endpoint resolves to
> `releases/latest`, so a published-early release would advertise a manifest
> that's missing platforms.

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
- On click: the plugin downloads the new artifact, verifies its signature
  against the embedded public key, installs it, and relaunches into the new
  version. On Windows that's the NSIS installer in `passive` mode (a small
  progress UI, no wizard clicks); on macOS the plugin swaps the `.app` bundle
  in place from the `.app.tar.gz` and there's no installer UI at all.

A failed or unreachable check never disrupts the app — it just stays silent.

The manifest carries one entry per platform — `windows-x86_64`,
`darwin-aarch64`, `darwin-x86_64` — which is why the release matrix builds both
Mac architectures separately rather than one universal binary: those are the
keys the updater client looks itself up under.

---

## Local test build (no release)

**Windows**

```powershell
# PowerShell 7:
pwsh scripts/release.ps1
# Windows PowerShell 5.1:
powershell -ExecutionPolicy Bypass -File scripts/release.ps1

# Bump the version at the same time:
pwsh scripts/release.ps1 -Version 0.2.0
```

**macOS**

```bash
scripts/release.sh

# Bump the version at the same time:
scripts/release.sh --version 0.2.0

# Cross-compile for Intel from an Apple Silicon Mac:
rustup target add x86_64-apple-darwin
scripts/release.sh --target x86_64-apple-darwin
```

Artifacts land in `dist-release/<version>/` — `{nsis,msi}/` on Windows,
`{dmg,macos}/` on macOS. These are for local testing; they're unsigned (unless
you set `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in
your shell first) and won't be accepted by the auto-updater.

> Expect `tauri build` itself to **exit 1** on a local build: `tauri.conf.json`
> carries an updater public key, so Tauri bundles everything and then fails at
> the signing step because there's no private key in the environment. The
> artifacts are already written and perfectly usable by then —
> `scripts/release.sh` checks for them rather than trusting the exit code, and
> says so when it happens.

---

## Code signing (optional, per platform)

The updater signature above authenticates *updates*. OS-level code signing is a
separate thing entirely, and the updater works fine without it — what it buys
you is a clean first-launch experience.

### Windows — Authenticode

Silences SmartScreen on first install. If you have a code-signing certificate,
point Tauri at it via `bundle.windows.signCommand` (or the
`certificateThumbprint` / `signingIdentity` options) in `tauri.conf.json`. An EV
certificate clears SmartScreen immediately; a standard OV cert builds reputation
over time. Without one, users get a dismissable SmartScreen warning on the first
install only.

### macOS — Developer ID + notarization

macOS is stricter than Windows here. A `.dmg` downloaded from GitHub gets the
`com.apple.quarantine` attribute, and Gatekeeper refuses to launch an unsigned,
un-notarized app from it — the dialog says the app **"is damaged and can't be
opened"**, which reads like a corrupt download rather than a signing problem.
Users can get past it, but only by knowing to run:

```bash
xattr -dr com.apple.quarantine /Applications/SoqlForge.app
```

To avoid putting that in your install instructions you need an **Apple Developer
Program** membership ($99/yr) and a *Developer ID Application* certificate. Add
these repository secrets and the release workflow signs and notarizes on its
own — no workflow edits needed, they're already wired up:

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application cert, exported as `.p12`, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set on that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Your Apple ID email (for notarization) |
| `APPLE_PASSWORD` | An [app-specific password](https://support.apple.com/en-us/102654), not your Apple ID password |
| `APPLE_TEAM_ID` | Your 10-character Team ID |

Notarization also matters for **auto-update**: the updater replaces the `.app`
bundle in place, and an unsigned replacement can trip Gatekeeper on the next
launch. If you ship to Mac users at any scale, budget for the certificate.

---

## Prerequisites (build machine / CI)

Both:

- Node 18+ (`npm`)
- Rust + cargo via `rustup`

Windows:

- Visual Studio Build Tools 2019+ (C++ workload)
- WebView2 runtime — ships with Windows 10 1809+; Tauri's NSIS installer
  downloads it automatically on older boxes.

macOS:

- Xcode Command Line Tools (`xcode-select --install`) — the full Xcode app
  isn't required
- For cross-compiling: `rustup target add x86_64-apple-darwin` (or
  `aarch64-apple-darwin` from an Intel Mac)
- WebKit is part of the OS; nothing to install or redistribute

---

## Quick reference

| Thing | Where it lives |
| --- | --- |
| App version (source of truth) | `src-tauri/tauri.conf.json` → `version` |
| Updater config (endpoint + pubkey) | `src-tauri/tauri.conf.json` → `plugins.updater` |
| Update check (frontend) | `src/hooks/useUpdater.ts` |
| Release workflow | `.github/workflows/release.yml` |
| Local build script | `scripts/release.ps1` (Windows) / `scripts/release.sh` (macOS) |
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
- **macOS: "SoqlForge is damaged and can't be opened."** Not a corrupt
  download — it's Gatekeeper refusing an unsigned app that arrived with the
  quarantine attribute. Clear it with
  `xattr -dr com.apple.quarantine /Applications/SoqlForge.app`, or set up
  Developer ID signing (above) so users never see it.
- **A release is missing one platform's assets or updater entry.** Check
  whether a matrix job failed — `fail-fast: false` means the others still
  publish. Re-running just the failed job appends to the same draft release;
  the `publish` job then flips it live.
- **macOS: every command fails with "Salesforce CLI not found", but `sf` works
  in Terminal.** A Finder-launched app inherits launchd's four-entry PATH, not
  your shell's. The bridge compensates (see `SEARCH_PATH` in
  [`src-tauri/src/cli.rs`](src-tauri/src/cli.rs)), but an unusual install
  location can still escape it — set an explicit path in **Settings → Salesforce
  CLI → Path override** using the output of `which sf`.
