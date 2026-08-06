# SoqlForge

A SOQLXplorer-style desktop app for **Windows and macOS** that drives the Salesforce CLI (`sf`) as its backend. No managed packages, no direct REST calls, no auth handling — everything goes through `sf --json` subprocess calls.

Built with **Tauri 2** (Rust) + **React + TypeScript** (Vite, Tailwind, CodeMirror 6, TanStack Table).

See [`agents.md`](./agents.md) for the v1 architecture and per-agent contracts.

## Prerequisites

Both platforms need **Node 18+**, **Rust** (via [rustup](https://rustup.rs)),
and the **Salesforce CLI**.

**Windows**

- Windows 10/11 with WebView2 (preinstalled on modern Windows)
- Rust: `winget install Rustlang.Rustup`
- Visual Studio Build Tools with C++ workload
- Salesforce CLI: `winget install Salesforce.SalesforceCLI`

**macOS**

- macOS 10.15+ (WebKit is built in — nothing to install)
- Xcode Command Line Tools: `xcode-select --install`
- Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Salesforce CLI: `brew install sf` (or the official `.pkg`)

## Dev

```bash
npm install
npm run tauri dev
```

## Release build (Tauri's bundled installers)

```bash
npm run tauri build
```

Output lands in `src-tauri/target/release/bundle/`:

| Platform | Artifacts |
| -------- | --------- |
| Windows  | `nsis/SoqlForge_<ver>_x64-setup.exe`, `msi/SoqlForge_<ver>_x64.msi` |
| macOS    | `dmg/SoqlForge_<ver>_<arch>.dmg`, `macos/SoqlForge.app` |

Or use the staging scripts, which build and copy the artifacts into
`dist-release/<version>/`: `scripts/release.ps1` on Windows,
`scripts/release.sh` on macOS.

> **macOS Gatekeeper.** Local builds and CI builds are unsigned unless an Apple
> signing identity is configured, so macOS quarantines the app when it arrives
> from anywhere but your own machine. Clear it once after installing:
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/SoqlForge.app
> ```
>
> See [`DEPLOYMENT.md`](./DEPLOYMENT.md) to set up signing and skip this.

## Releasing + auto-update

Releases are built and published by CI: push a `v*` tag and GitHub Actions
builds the signed Windows installers and macOS disk images (Apple Silicon +
Intel), generates the updater manifest, and publishes a GitHub Release.
Installed apps check that release on startup and self-update via Tauri's
updater plugin — no third-party installer tooling required.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the one-time signing-key setup and
the full flow.

## Keyboard shortcuts

`Mod` is `Ctrl` on Windows and `⌘` on macOS; both are accepted on either
platform. `Ctrl+Space` stays `Ctrl` everywhere — `⌘Space` belongs to Spotlight.

| Shortcut            | Action                          |
| ------------------- | ------------------------------- |
| `Mod+Enter` / `F5`  | Run query                       |
| `Alt+↑` / `Alt+↓`   | Walk query history (in editor)  |
| `Tab`               | Accept ghost-text prediction    |
| `Ctrl+Space`        | Force autocomplete popup        |
| `Mod+,`             | Open settings                   |
| `Esc`               | Close settings / dismiss editor |

## Features

- Multiple query tabs with per-tab state (query text, toggles, results)
- Schema-aware autocomplete with relationship traversal + subquery scope
- Ghost-text SOQL skeleton predictions (Tab to accept)
- Inline cell editing with picklist dropdowns + boolean/date/number widgets
- CSV export with subquery flattening + native "Open" button
- Saved queries sidebar + query history
- NL→SOQL AI assist (BYO API key — Claude / Gemini / OpenAI).
  **Note:** the API key is stored in plaintext in the app's local settings file
  — `%APPDATA%\com.soqlforge.app\settings.json` on Windows,
  `~/Library/Application Support/com.soqlforge.app/settings.json` on macOS —
  not in the OS keyring. Use a scoped, revocable key.
- Light + dark themes
- Tooling API / Bulk API / All Rows toggles per tab

## Contributing

Contributions welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). CI runs
`tsc` plus `cargo fmt --check`, `cargo clippy`, and `cargo test` on **both**
Windows and macOS on every PR — the CLI bridge has real `#[cfg(windows)]` /
`#[cfg(unix)]` branches, so one platform passing proves nothing about the other.

## License

[MIT](./LICENSE)

## Disclaimer

SoqlForge is provided **free and as-is**, with no warranty of any kind. You're
welcome to use, modify, and distribute it, but you do so at your own risk. Ask
the Forge and the project's contributors are **not responsible** for any data
loss, damage, or other consequences arising from its use — including anything
that happens to your Salesforce orgs or data. Always verify queries and edits
against non-production data first. (This restates, in plain English, the
liability and warranty terms in the [MIT License](./LICENSE).)

---

**Name history.** Project was originally scaffolded as "SOQLForge", briefly
renamed to "SOQLNav", and is now "SoqlForge". The repo directory
(`winSFExplorer`) is the original working title.

---

<div align="center">

⚒ **Built by [Ask the Forge](https://asktheforge.com)** ⚒

Free, open-source tools for the Salesforce community.

</div>
