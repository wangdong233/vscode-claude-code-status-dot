# Change Log — cc-status-dot Companion

All notable changes to the **cc-status-dot Companion** VS Code extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-07-19

### Added

- Initial companion release.
- Detects Claude Code extension auto-update (missing `cc-status-dot-injected` marker in CC's `extension.js`) on VS Code startup.
- Silently re-applies the patch by re-executing `node ~/.claude/cc-status-dot/patch.js`.
- Prompts the user for a one-click **Reload Window** to activate the refreshed patch.
- Idempotent via a `globalThis.__ccsdCompanionRan` once-guard so multi-root workspaces don't multi-fire.
