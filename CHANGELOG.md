# Changelog

All notable changes to Gaugeshift are listed here.

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
- Automated tests for the engine (about 70 scenarios) and the backend (about 40), run on every push.
- Releases are only built when all checks pass.

### Fixed

- Device dropdowns were too narrow to show the chosen resolution ("1920x1…"). They now sit under the device name at full width.
- An error while updating the panel could stop Gaugeshift from handling any later event until it was restarted.
- A log line Steam was still writing could be missed by the launch watcher.

## [0.4.0] - 2026-11-24

First public release.
