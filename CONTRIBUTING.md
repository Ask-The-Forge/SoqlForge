# Contributing to SoqlForge

Thanks for your interest in contributing!

## Getting set up

See the [README](./README.md#prerequisites) for prerequisites (Node 18+, Rust,
VS Build Tools, Salesforce CLI). Then:

```bash
npm install
npm run tauri dev
```

## Before you open a PR

Run the same checks CI runs:

```bash
# Frontend typecheck
npx tsc --noEmit

# Rust format, lint, tests (from src-tauri/)
cargo fmt --check
cargo clippy --all-targets
cargo test
```

All of these must pass. `cargo clippy` warnings should be fixed, not
`#[allow]`-ed, unless there's a good reason documented in a comment.

## Guidelines

- Keep PRs focused — one feature or fix per PR.
- The app talks to Salesforce **only** through `sf --json` subprocess calls.
  No direct REST calls, no auth handling, no managed packages. Please keep it
  that way — it's the project's core design constraint (see
  [`agents.md`](./agents.md)).
- New Rust code that parses `sf` output should come with unit tests (see
  `src-tauri/src/cli.rs` for examples).
- UI changes: include a screenshot in the PR description.

## Reporting bugs

Open a GitHub issue with:

- Windows version and `sf --version` output
- Steps to reproduce
- What you expected vs. what happened
- Any error text from the app's status bar or an `RUST_LOG=debug` run
