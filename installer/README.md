# Advanced Installer setup (one-time)

The project file lives at the repo root: **`SoqlForge.aip`**. This folder
holds the docs + (eventually) any AI-side fragment/include files.
`scripts/build-msi.ps1` resolves the .aip from either repo root or this
folder, so move it here if you'd rather group everything.

The initial setup was done via a mix of the GUI (Product Name, Manufacturer,
UpgradeCode, per-user install location, package type) and the AI CLI (file
add, shortcut, version bump, build). That gave us a working MSI at
`dist-release/0.1.0/SoqlForge-0.1.0.msi`. Per-release rebuilds are
`scripts/build-msi.ps1` — no GUI needed.

> **License tier**: the **Updater** feature (silent in-app updates) requires
> Advanced Installer **Enterprise** or **Architect**. Our `.aip` is currently
> **Professional**, so the AI CLI errors with `The updater could not be
> found in your project` on `/SetUpdatesUrl`. To enable Updater:
> **File → Project Type → Enterprise** (one-time, then re-save). Until then
> the MSI installs and uninstalls fine — you just push updates manually.

## What's already set in `SoqlForge.aip`

| Field | Value | Set via |
| --- | --- | --- |
| Product Name | `SoqlForge` | GUI |
| Product Version | `0.1.0` (bumped per release by `build-msi.ps1`) | CLI `/SetVersion` |
| Manufacturer | `Ask the Forge` | GUI |
| Upgrade Code | `{5D5B3F76-4F4A-4D63-B5DC-7F3F7E0A3F25}` — **must match `src-tauri/tauri.conf.json` `bundle.windows.wix.upgradeCode`** | GUI |
| Install scope | per-user → `[LocalAppDataFolder]Programs\SoqlForge\` | GUI |
| Package type | `x64` | GUI |
| Shortcut | `SoqlForge` → `[APPDIR]soqlforge.exe` in `SHORTCUTDIR` (resolves to Desktop by default; flip to `[ProgramMenuFolder][ProductName]` in GUI for Start Menu) | CLI `/NewShortcut` |
| File: `soqlforge.exe` | refreshed from `dist-release\<ver>\soqlforge.exe` each build | CLI `/AddFile` (first time) / `/UpdateFile` (subsequent) |

## What still needs the GUI (optional, future)

1. **Upgrade to Enterprise** (`File → Project Type → Enterprise`) to unlock
   the Updater feature, then:
   - **Resources → Updater → URL** → `https://intranet.yourco.com/soqlforge/updates.xml`
   - **Updates file** → `..\dist-release\updates.xml`
   - **Update mode** → "Prompt user" while you stabilise, then flip to "Silent"
2. **Resources → Prerequisites → Add From Catalog →
   "Microsoft Edge WebView2 Runtime (evergreen bootstrapper)"**. Win10
   1809+ ships WebView2 preinstalled but the bootstrapper handles
   stragglers silently.
3. **Digital Signature** (if you have a code-signing cert) — silences
   SmartScreen for internal users.

## Per-release flow

```powershell
# Bump version + Tauri build + drive AI CLI to refresh+build MSI
powershell -ExecutionPolicy Bypass `
  -File scripts\build-msi.ps1 `
  -Version 0.2.0
```

What the script does:
1. Runs `scripts/release.ps1` to build `soqlforge.exe` and stage it in
   `dist-release/<ver>/`.
2. Resolves `AdvancedInstaller.com` (handles the versioned install dir
   `Caphyon\Advanced Installer 23.5.1\bin\x86\` automatically).
3. Drives the CLI to: `/SetVersion`, `/UpdateFile soqlforge.exe`, `/build`.
   Once Enterprise is in play, also `/BuildUpdatesFile`.
4. Copies the produced MSI (+ `updates.xml` if generated) into
   `dist-release/<ver>/` ready to upload.

See `DEPLOYMENT.md` at the repo root for the broader hosting + rollout
story.
