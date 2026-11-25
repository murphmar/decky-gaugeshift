# Security and safety

Gaugeshift changes one Steam setting while a device streams from your machine, and puts it back afterwards. This page lists everything it touches, what it can't do, and how you can check both for yourself.

## What Gaugeshift touches

| What                                                                             | How                                                                            | Why                                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Steam's **Maximum Game Resolution** setting (`gamescope_game_resolution_global`) | Reads it, and changes it through Steam's own `SteamClient.Settings.SetSetting` | It's the setting Gaugeshift exists to manage                                         |
| Steam's Remote Play status and device list                                       | Listens through `SteamClient.RemotePlay`                                       | To know which device is streaming                                                    |
| Steam's game-launch events                                                       | Listens through `SteamClient.Apps.RegisterForGameActionStart`                  | To tell launches on this machine from launches requested by another device           |
| `~/.local/share/Steam/logs/console_log.txt`                                      | **Reads** only                                                                 | Launches requested by another Steam device show up here seconds before anywhere else |
| `~/.local/share/Steam/logs/streaming_log.txt`                                    | **Reads** only                                                                 | Each streaming device reports its screen size here, for **Match screen**             |
| `~/homebrew/settings/gaugeshift/config.json`                                     | Reads and writes                                                               | Your rules, and what to restore after a stream                                       |
| `~/homebrew/logs/gaugeshift/`                                                    | Writes (through Decky)                                                         | Its own log, for troubleshooting                                                     |

That's the complete list. Gaugeshift doesn't touch any other setting or file.

## What Gaugeshift can't do

- **No root access.** `plugin.json` asks for no special permissions, so Decky runs Gaugeshift as your normal user, not as root.
- **No network access.** No code in Gaugeshift sends or receives anything over the network, and it contains no URLs apart from a standard SVG namespace identifier.
- **No running other programs.** The backend can't start processes or run shell commands.
- **No downloaded or generated code.** Everything that runs is in the release zip; nothing is fetched or built at runtime.
- **No binaries.** The plugin is plain JavaScript and Python that you can read.

These aren't just promises. `scripts/check_safety.py` checks all of them, in the source code and in the built bundle, and fails the build on GitHub if any of them stops being true. For example, it fails if:

- the plugin asks for root;
- a network call or URL appears;
- the backend imports anything beyond a short list of standard modules;
- the frontend calls a backend method that isn't on the approved list.

## Why it can't break your system

- **It only uses Steam's own setting.** It changes the value you could set yourself in **Settings → Display → Maximum Game Resolution**, and Steam checks the value. Gaugeshift never edits system files, boot settings, display settings (EDID) or anything outside its own folder.
- **Every change is undone:**
  - Before changing the setting, Gaugeshift saves what to restore.
  - It restores that value when the stream ends, when you turn Gaugeshift off, and when it's disabled, updated or uninstalled.
  - If Steam or the machine restarts mid-stream, it restores the value the next time it starts.
- **It won't overwrite you.** If you change the setting yourself during a stream, Gaugeshift leaves your value alone.
- **It does nothing when unsure.** If it can't read the current value, it doesn't change anything, because it couldn't guarantee putting it back. It shows a warning instead.
- **It's safe to remove.** If Gaugeshift ever misbehaved, uninstalling it from Decky puts the setting back. You can always reset the setting yourself in Settings → Display.

## How it's checked

On every change, GitHub runs:

- **Type checking, formatting and linting** for the TypeScript and Python code.
- **About 90 frontend tests**, with minimum coverage enforced:
  - Every scenario we know of: streams, launches from other devices, rule changes, restarts and failures.
  - **Randomized stress tests**, which try thousands of random sequences of events and check every time that the setting ends up back where you left it. To make sure they work, we deliberately broke the code in several ways, and the stress tests caught every one.
- **About 40 backend tests**, on Python 3.11 and 3.14 (the version Decky uses). They cover corrupted settings files, interrupted saves, and Steam rotating or truncating its log.
- **The safety check** described above.
- **A dependency audit** for known vulnerabilities, plus GitHub's **CodeQL** code scanning every week and on every change.

Dependabot keeps dependencies up to date. All GitHub Actions used by the build are pinned to exact commits.

[docs/TESTING.md](docs/TESTING.md) has the hardware test checklist and its results for each release.

## Verifying a download

Every release is built by GitHub Actions from the tagged source code, never on someone's own computer. GitHub signs a record of how each zip was built. To check that a download matches the source code of its release:

```sh
gh attestation verify gaugeshift.zip --repo murphmar/decky-gaugeshift
sha256sum -c SHA256SUMS   # with SHA256SUMS from the same release
```

## Reporting a security problem

Please don't open a public issue for a security problem. Use GitHub's **private vulnerability reporting** instead: open the repository's **Security** tab and choose **Report a vulnerability**.
