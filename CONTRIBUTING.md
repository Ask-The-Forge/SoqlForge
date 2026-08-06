# Contributing to SoqlForge

Thanks for your interest in contributing!

## Getting set up

See the [README](./README.md#prerequisites) for prerequisites — Node 18+, Rust,
and the Salesforce CLI on both platforms, plus VS Build Tools on Windows or the
Xcode Command Line Tools on macOS. Then:

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

CI runs the Rust checks on **both Windows and macOS**. If you touch
`src-tauri/src/cli.rs` or anything else behind a `#[cfg(windows)]` /
`#[cfg(unix)]` gate, remember your local run only compiled one side — clippy
can't lint code it didn't build, so the other platform's CI job is the first
thing that will see it.

A few tests are `#[ignore]`d because they need the Salesforce CLI installed and
authenticated. Run them locally when you change the CLI bridge:

```bash
cargo test --lib -- --ignored
```

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

- Your OS and version, plus `sf --version` output
- Steps to reproduce
- What you expected vs. what happened
- Any error text from the app's status bar or an `RUST_LOG=debug` run
