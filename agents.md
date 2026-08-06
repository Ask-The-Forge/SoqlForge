# SOQLForge — Project Agents & Architecture Guide

> A SOQLXplorer-style desktop application for Windows and macOS that uses the Salesforce CLI (`sf`) as its backend engine. All Salesforce data operations go through CLI subprocess calls — no direct API calls, no managed packages, no auth token handling in the app.

---

## Tech Stack Decision

### Chosen: Tauri 2 (Rust backend + React/TypeScript frontend)

**Why Tauri over the alternatives:**

| Concern | Electron | Tauri | C# WPF | Python |
|---|---|---|---|---|
| Bundle size | ~120MB+ | ~5–15MB | ~50–80MB | ~80MB+ |
| Distribution | Painful (no store, large installer) | NSIS/MSI installer built-in | ClickOnce or manual | PyInstaller fragile |
| CLI subprocess control | Node `child_process` — fine | Rust `std::process::Command` — excellent | `System.Diagnostics.Process` — fine | `subprocess` — fine |
| Web UI (modern look) | ✅ | ✅ | ❌ (XAML) | ❌ |
| Cross-platform later | ✅ | ✅ | ❌ Windows only | ✅ |
| AI features later | Easy | Easy | Harder | Easy |
| Memory footprint | High (Chromium) | Low (WebView2, already on Win10/11) | Low | Medium |
| Dev experience | Excellent | Excellent | Good | OK |

**Decision rationale:** Tauri hits every constraint. The bundle is small enough to distribute casually (email, GitHub releases, internal portal). WebView2 ships with Windows 10/11 so there's no Chromium to bundle. Rust gives precise, non-blocking subprocess control for CLI calls. The React frontend makes AI features trivially addable later. If you ever want Mac/Linux builds, Tauri supports it with zero frontend changes.

**The only real tradeoff:** You'll write some Rust for the CLI bridge layer. It's not much (~200–400 lines), it's well-documented, and Tauri's `tauri::command` pattern is clean. Claude Code can generate this.

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│                 React Frontend               │
│  (TypeScript + Vite + Tailwind + shadcn/ui) │
│                                              │
│  OrgSelector  │  QueryEditor  │  ResultGrid  │
└──────────────────────┬──────────────────────┘
                       │ invoke() — Tauri IPC
┌──────────────────────▼──────────────────────┐
│              Rust Command Layer              │
│   tauri::command handlers — thin wrappers   │
│   around sf CLI subprocess calls            │
│                                             │
│   run_soql()  list_orgs()  get_schema()     │
└──────────────────────┬──────────────────────┘
                       │ std::process::Command
┌──────────────────────▼──────────────────────┐
│           Salesforce CLI (sf)               │
│   sf org list --json                        │
│   sf data query -q "..." -o <alias> --json  │
│   sf sobject describe -s Account -o <alias> │
└─────────────────────────────────────────────┘
```

All CLI calls use `--json` flag. The Rust layer parses the JSON output and forwards structured data to the frontend via Tauri's type-safe IPC. The app never touches OAuth tokens, `.sfdx` credential files, or the Salesforce REST API directly — `sf` handles all of that.

---

## Repository Structure

```
soqlforge/
├── src-tauri/                  # Rust backend
│   ├── src/
│   │   ├── main.rs             # Tauri app setup, window config
│   │   ├── cli.rs              # Core: spawn sf CLI, capture output
│   │   ├── commands/
│   │   │   ├── orgs.rs         # list_orgs, get_org_detail
│   │   │   ├── query.rs        # run_soql, run_soql_tooling
│   │   │   └── schema.rs       # list_objects, describe_object (v2+)
│   │   └── error.rs            # Unified error type → frontend
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── src/                        # React frontend
│   ├── components/
│   │   ├── OrgPicker/          # Dropdown + org status badge
│   │   ├── QueryEditor/        # Monaco editor instance
│   │   ├── ResultsGrid/        # Virtual table (TanStack Table)
│   │   ├── StatusBar/          # Active org, row count, timing
│   │   └── Layout/             # Shell, sidebar, panels
│   ├── hooks/
│   │   ├── useOrgs.ts          # list_orgs + polling
│   │   ├── useQuery.ts         # run_soql state management
│   │   └── useSchema.ts        # object describe cache
│   ├── stores/
│   │   └── appStore.ts         # Zustand — active org, query history
│   ├── lib/
│   │   └── tauriClient.ts      # Typed wrappers around invoke()
│   ├── App.tsx
│   └── main.tsx
│
├── agents.md                   # This file
├── package.json
└── README.md
```

---

## Agents

### Agent 1 — CLI Bridge (Rust)

**Scope:** Everything in `src-tauri/src/`

**Responsibilities:**
- Spawn `sf` as a subprocess using `std::process::Command`
- Pass `--json` flag on every call; parse stdout as JSON
- Surface structured errors: distinguish CLI-not-found, auth expired, query parse error, timeout
- Expose Tauri commands callable from the frontend

**Key commands to implement (v1):**

```rust
// orgs.rs
#[tauri::command]
async fn list_orgs() -> Result<Vec<OrgEntry>, AppError>
// Runs: sf org list --json
// Returns: alias, username, instanceUrl, isDefaultOrg, connectedStatus

// query.rs  
#[tauri::command]
async fn run_soql(org_alias: String, query: String) -> Result<QueryResult, AppError>
// Runs: sf data query -q "<query>" -o <alias> --json
// Returns: totalSize, records (Vec<serde_json::Value>), columns derived from first record

#[tauri::command]
async fn run_soql_tooling(org_alias: String, query: String) -> Result<QueryResult, AppError>
// Same but adds --use-tooling-api flag
```

**Error handling contract:**
```rust
// All commands return this — serialized to frontend as { code, message, detail }
pub enum AppError {
    CliNotFound,           // sf not installed / not on PATH
    AuthExpired(String),   // org alias exists but session gone
    QueryError(String),    // SOQL parse/execution error from SF
    Timeout,               // subprocess hung > N seconds
    ParseError(String),    // sf returned non-JSON (unexpected)
}
```

**Rules for this agent:**
- Never hardcode CLI path; resolve from PATH, with a settings override
- All subprocess calls must be async (use `tokio::process::Command`)
- Stdout and stderr captured separately; stderr logged but not surfaced unless stdout is empty
- Strip ANSI escape codes from output before JSON parse (sf occasionally emits them)
- Query timeout default: 30s, configurable

---

### Agent 2 — Org Manager (Frontend)

**Scope:** `src/components/OrgPicker/`, `src/hooks/useOrgs.ts`

**Responsibilities:**
- Call `list_orgs` on app launch and on manual refresh
- Display orgs in a dropdown: alias, username, connected status indicator (green/yellow/red)
- Persist last-used org alias in `localStorage`
- Surface "sf not found" error state gracefully with install link

**State shape:**
```typescript
type OrgEntry = {
  alias: string;
  username: string;
  instanceUrl: string;
  isDefault: boolean;
  connectedStatus: 'Connected' | 'RefreshTokenError' | 'Unknown';
};
```

**Rules for this agent:**
- No polling in v1; refresh is manual (button or keyboard shortcut)
- "Connected" orgs sorted to top
- Changing active org clears the result grid and resets query state

---

### Agent 3 — Query Editor (Frontend)

**Scope:** `src/components/QueryEditor/`, `src/hooks/useQuery.ts`

**Responsibilities:**
- Embed Monaco Editor (same engine as VS Code) for SOQL editing
- Syntax highlighting for SOQL (register a custom language or use SQL as base)
- Run query on `Cmd+Enter` / `F5`
- Query history: last 50 queries persisted in `localStorage`, browsable with up/down arrows
- Toggle between standard API and Tooling API

**Monaco integration notes:**
- Use `@monaco-editor/react` package
- Register `soql` language with basic tokenizer (keywords: SELECT, FROM, WHERE, LIMIT, ORDER BY, GROUP BY, HAVING, LIKE, IN, NOT IN, INCLUDES, EXCLUDES, TYPEOF, WITH)
- Autocomplete for keywords in v1; object/field autocomplete deferred to v2 (requires schema agent)

**State shape:**
```typescript
type QueryState = {
  text: string;
  isRunning: boolean;
  useToolingApi: boolean;
  error: string | null;
  lastRunMs: number | null;
};
```

**Rules for this agent:**
- Query runs only when an org is selected; otherwise show inline warning
- Errors from CLI bridge rendered inline below editor, not in a modal
- Editor min-height 120px, resizable via drag handle

---

### Agent 4 — Results Grid (Frontend)

**Scope:** `src/components/ResultsGrid/`, `src/components/StatusBar/`

**Responsibilities:**
- Render query results in a virtualized table (TanStack Table v8 + TanStack Virtual)
- Columns derived dynamically from first record's keys
- Relationship fields (e.g. `Account.Name`) displayed as dot-notation column headers
- Column resizing, sortable client-side
- Export to CSV
- Status bar: row count, query execution time, active org alias

**Rules for this agent:**
- Virtualize rows — results can be 50k records; no pagination in the data layer (sf returns all records via bulk query path automatically)
- null values displayed as empty cell, not "null" string
- Boolean values rendered as checkboxes (read-only)
- ID fields (18-char) rendered with a copy-to-clipboard icon on hover
- No inline record editing in v1

---

### Agent 5 — App Shell & State (Frontend)

**Scope:** `src/stores/appStore.ts`, `src/App.tsx`, `src/lib/tauriClient.ts`

**Responsibilities:**
- Zustand store: active org, query history, UI preferences (theme, font size)
- Typed `invoke()` wrappers so components never call Tauri directly
- Keyboard shortcut registration (via `@tauri-apps/plugin-global-shortcut` or `useHotkeys`)
- Settings panel: CLI path override, query timeout, theme toggle

**tauriClient.ts pattern:**
```typescript
import { invoke } from '@tauri-apps/api/core';

export const listOrgs = () =>
  invoke<OrgEntry[]>('list_orgs');

export const runSoql = (orgAlias: string, query: string, tooling = false) =>
  invoke<QueryResult>(tooling ? 'run_soql_tooling' : 'run_soql', { orgAlias, query });
```

---

## v1 Scope Boundary

**In:**
- Org connection manager (list authenticated orgs from sf)
- SOQL editor with Monaco
- Results grid with export
- Tooling API toggle
- Query history
- Basic error surfacing

**Explicitly out of v1:**
- Schema / object browser
- Record edit / DML
- Anonymous Apex execution
- Deploy / retrieve metadata
- AI features (NL→SOQL, query explain)
- Multi-tab query sessions
- Saved queries / query library

---

## Development Setup

### Prerequisites
```bash
# Windows
winget install Rustlang.Rustup
winget install Salesforce.SalesforceCLI
node >= 18 (via nvm-windows or fnm)

# macOS
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
brew install sf
node >= 18 (via nvm, fnm, or brew)
```

### Bootstrap
```bash
npm create tauri-app@latest soqlforge -- --template react-ts
cd soqlforge
npm install
npm install @monaco-editor/react @tanstack/react-table @tanstack/react-virtual zustand
npm install -D tailwindcss @types/node
npm run tauri dev
```

### Build & Distribute
```bash
npm run tauri build
# Produces: src-tauri/target/release/bundle/
#   Windows:
#     nsis/SoqlForge_x.x.x_x64-setup.exe  (installer)
#     msi/SoqlForge_x.x.x_x64.msi         (MSI for enterprise)
#   macOS:
#     dmg/SoqlForge_x.x.x_<arch>.dmg      (disk image)
#     macos/SoqlForge.app                 (app bundle)
```

**Platform split in the CLI bridge.** `src-tauri/src/cli.rs` is the one file
where the two targets genuinely diverge, and the divergences are not cosmetic:

- **Argument quoting.** On Windows `sf` is a `.cmd` batch file, so args go
  through cmd.exe and need `raw_arg` + manual quoting (BatBadBut,
  CVE-2024-24576). Unix hands argv straight to `execve` — no quoting layer, and
  no `%VAR%` hazard, which is why the `%...%` rejection in
  `commands/update.rs` is `#[cfg(windows)]`.
- **PATH.** A Finder-launched macOS app inherits launchd's
  `/usr/bin:/bin:/usr/sbin:/sbin`, so `sf` is invisible to a plain PATH lookup
  even when it works in Terminal. `SEARCH_PATH` rebuilds a usable one and is
  also handed to the child, since `sf` is a shell script that has to find
  `node` itself.
- **Cancellation.** `sf` spawns node as a *child* on both platforms, so killing
  the direct pid isn't enough: Windows uses `taskkill /T`, Unix spawns into a
  new process group and signals the negated pid.

CI runs `cargo clippy`/`cargo test` on both OSes because each build only ever
compiles half of this.

---

## Key Constraints & Conventions

1. **All SF operations go through `sf` CLI.** No direct HTTP to Salesforce. No `jsforce`. No credential handling.
2. **Always use `--json` flag.** Parse stdout as JSON. Treat non-JSON stdout as an error.
3. **Rust layer is thin.** No business logic in Rust. Rust = spawn process, parse JSON, return typed struct. Logic lives in React/TypeScript.
4. **Type everything.** Rust structs must match TypeScript types. Use `serde` in Rust, `zod` in TS for runtime validation at the IPC boundary.
5. **No modals for errors.** Inline error states only. Modals reserved for destructive confirmations (future DML features).
6. **Virtualize all lists.** Org list, result grid, query history — assume scale.

---

## Future Agents (v2+)

- **Agent 6 — Schema Browser:** `sf sobject list`, `sf sobject describe` — sidebar tree of objects/fields, click-to-insert in query editor
- **Agent 7 — AI Query Assistant:** Claude API integration, NL→SOQL, query explain, field suggestion. Drop-in given the React frontend.
- **Agent 8 — Apex Runner:** Monaco editor for anonymous Apex, `sf apex run` bridge
- **Agent 9 — Metadata Explorer:** `sf project retrieve`, basic metadata viewer
