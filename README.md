# SoqlForge

A SOQLXplorer-style desktop app for Windows that drives the Salesforce CLI (`sf`) as its backend. No managed packages, no direct REST calls, no auth handling — everything goes through `sf --json` subprocess calls.

Built with **Tauri 2** (Rust) + **React + TypeScript** (Vite, Tailwind, CodeMirror 6, TanStack Table).

See [`agents.md`](./agents.md) for the v1 architecture and per-agent contracts.

## Prerequisites

- Windows 10/11 with WebView2 (preinstalled on modern Windows)
- Node 18+
- Rust (`winget install Rustlang.Rustup`)
- Visual Studio Build Tools with C++ workload
- Salesforce CLI: `winget install Salesforce.SalesforceCLI`

## Dev

```bash
npm install
npm run tauri dev
```

## Release build (Tauri's bundled installers)

```bash
npm run tauri build
# Output: src-tauri/target/release/bundle/
#   nsis/SoqlForge_<ver>_x64-setup.exe
#   msi/SoqlForge_<ver>_x64.msi
```

Or use `scripts/release.ps1`, which builds and stages the installers under
`dist-release/<version>/`.

## Releasing + auto-update

Releases are built and published by CI: push a `v*` tag and GitHub Actions
builds the signed installers, generates the updater manifest, and publishes a
GitHub Release. Installed apps check that release on startup and self-update
via Tauri's updater plugin — no third-party installer tooling required.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the one-time signing-key setup and
the full flow.

## Keyboard shortcuts

| Shortcut             | Action                                |
| -------------------- | ------------------------------------- |
| `Ctrl+Enter` / `F5`  | Run query                             |
| `Alt+↑` / `Alt+↓`    | Walk query history (in editor)        |
| `Tab`                | Accept ghost-text prediction          |
| `Ctrl+Space`         | Force autocomplete popup              |
| `Ctrl+,`             | Open settings                         |
| `Esc`                | Close settings / dismiss editor       |

## Features

- Multiple query tabs with per-tab state (query text, toggles, results)
- Schema-aware autocomplete with relationship traversal + subquery scope
- Ghost-text SOQL skeleton predictions (Tab to accept)
- Inline cell editing with picklist dropdowns + boolean/date/number widgets
- CSV export with subquery flattening + native "Open" button
- Saved queries sidebar + query history
- NL→SOQL AI assist (BYO API key — Claude / Gemini / OpenAI).
  **Note:** the API key is stored in plaintext in the app's local settings
  file (`%APPDATA%`), not in the OS keyring — use a scoped, revocable key.
- Light + dark themes
- Tooling API / Bulk API / All Rows toggles per tab

## Contributing

Contributions welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). CI runs
`tsc`, `cargo fmt --check`, `cargo clippy`, and `cargo test` on every PR.

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
