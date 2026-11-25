# Changelog

All notable changes to Gaugeshift are listed here.

## [0.6.0] - Unreleased

### Added

- **Match screen:** a device's resolution can now follow its own screen. Gaugeshift learns each device's screen size from what it reports when it streams, and assumes 1280x800 for a Steam Deck it hasn't heard from yet.
- **New devices** setting: what a device gets the first time it streams. It defaults to **Match their screen**, so Gaugeshift works with no setup, and a new Steam Deck is covered from its very first launch.

### Changed

- Settings now save "Don't change" explicitly. When upgrading, devices that were already known keep their current behavior.

## [0.5.0] - 2026-11-25

### Changed

- Rebuilt the decision-making as a separate, fully tested engine.
- The settings file is now validated on every load and save, and written with a flush to disk first.
- When several online devices have rules, a launch from another Steam device now uses the rule of the device that
  streamed most recently, instead of waiting for the stream (which was too late for the game).

### Added

- **Warnings in the panel** when something isn't working:
  - Steam's setting can't be read. Gaugeshift then changes nothing, rather than risk restoring the wrong value.
  - A change or restore didn't work.
  - Launches from other devices can't be detected with the current Steam version.
- Failed changes and restores are retried. A restore that still fails is kept and retried on the next stream, the
  next start, or with the Restore button.
- About 130 automated tests, run on every change:
  - The engine's scenarios.
  - Randomized stress tests of thousands of random event sequences.
  - The Steam adapter.
  - The backend.
- Minimum test coverage is enforced.
- A safety check that fails the build if Gaugeshift ever asks for root, gains network access, runs other programs or loads code at runtime.
- Dependency vulnerability audits, CodeQL code scanning, Dependabot updates, and GitHub Actions pinned to exact commits.
- Releases are built on GitHub only after every check passes. They come with a SHA-256 checksum and signed build provenance, so anyone can verify a download.
- SECURITY.md, ARCHITECTURE.md, a hardware test checklist with results (docs/TESTING.md), and a "How this was made" section in the README.
- Development dependencies updated; no known vulnerabilities remain.

### Fixed

- Notifications were cut off before the resolution. They now show it in full ("Maximum Resolution: 1920x1200"), and a test makes sure every notification fits on screen.
- Device dropdowns were too narrow to show the chosen resolution ("1920x1…"). They now sit under the device name at full width.
- An error while updating the panel could stop Gaugeshift from handling any later event until it was restarted.
- A log line Steam was still writing could be missed by the launch watcher.

## [0.4.0] - 2026-11-24

First public release.
