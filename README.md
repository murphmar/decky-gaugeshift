# Gaugeshift

**Per-device game resolution for Remote Play and Steam Link.**

Gaugeshift is a [Decky Loader](https://decky.xyz) plugin for SteamOS machines that you stream _from_, such as a Steam Machine or a Steam Deck sitting in its dock. When a device starts streaming from it, Gaugeshift changes Steam's **Maximum Game Resolution** to the size you picked for that device. When the device disconnects, Gaugeshift puts the setting back to whatever it was before.

Like a train changing gauge at a border, your games re-fit themselves to whichever screen they're heading to.

## Why

Say your Steam Machine is plugged into a 4K TV. When you stream a game to a Steam Deck (a 16:10 screen) or a phone, the game still renders at the TV's resolution. Then the whole picture gets shrunk, letterboxed and squeezed down the network. That makes the machine work harder for a worse picture.

Steam already has a fix built in: **Settings → Display → Maximum Game Resolution**. But it's one global setting, so you'd have to change it by hand every time you switch between the TV and a handheld. Steam's menu also only offers resolutions that suit the connected display, so a 16:10 size like 1920x1200 may not even be on the list when the display is a 16:9 TV.

Gaugeshift switches the setting for you, per device, and accepts any resolution.

## Features

- **A rule for each device.** Pick a resolution for each device that streams from this machine, or "Don't change". Choose from the common sizes, **Native**, or **Custom…** to type any size, such as `2560x1080`.
- **Restores what you had.** When a stream ends, Gaugeshift puts back the value the setting had before, not just "Default". If you change the setting yourself during a stream, it leaves your choice alone.
- **Works with both kinds of streaming:**
  - **Steam Link** (on a phone, tablet or TV), where you browse Big Picture and launch games from there.
  - **Remote Play from another Steam client**, such as a Steam Deck choosing **Stream** on a game in its library. Gaugeshift catches these launches several seconds before the game starts.
- **Survives crashes and restarts.** What to restore is saved to disk, so the setting still goes back to the right value if Steam, Decky or the machine restarts mid-stream.
- **Applies changes straight away.** If you change a device's rule while it's streaming, the setting changes immediately.
- **Never leaves the setting changed.** Turning the plugin off, disabling it, updating it or uninstalling it restores the original setting first.

## Install

Gaugeshift is not in the Decky Plugin Store yet. Until it is, install it from a URL:

1. Open Decky's settings (Quick Access Menu → Decky tab → gear icon) and turn on **Developer mode**.
2. Go to the **Developer** section, choose **Install Plugin from URL**, and enter:
   ```
   https://github.com/murphmar/decky-gaugeshift/releases/latest/download/gaugeshift.zip
   ```
3. Confirm the install prompt.

## Use

1. Stream to the machine once from each device you use, so Gaugeshift learns its name. Devices paired for Steam Link show up straight away.
2. Open **Gaugeshift** in the Quick Access Menu and pick a resolution for each device. For example:
   - **steamdeck** → `1920x1200` (16:10, 1.5× the Deck's screen)
   - **iPhone** → `1920x1080`
3. Stream as usual. A notification tells you when Gaugeshift switches the resolution.

### Good to know

- **Games read the setting when they launch.** If a game is already running when a device connects, it keeps its current resolution until you restart it.
- **Per-game overrides win.** If a game has its own **Game Resolution** set in its Properties, Steam uses that instead of the global setting.
- **Remote launches pick a device in advance.** When a Steam client asks this machine to launch a game, Steam doesn't say which device asked until the stream connects, which is too late. So Gaugeshift applies the rule of the online device with a rule that streamed most recently. When the stream connects, Gaugeshift checks the guess and corrects it if needed. If no stream follows within a minute, it undoes the change.

### Warnings

Gaugeshift shows a warning in its panel when something isn't working:

| Warning                                       | What Gaugeshift does                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Can't read Maximum Game Resolution            | Changes nothing, because it couldn't put the old value back afterwards.                                               |
| Couldn't change the resolution                | Leaves the setting as it was.                                                                                         |
| Couldn't put the resolution back              | Keeps trying on the next stream or restart. You can also press **Restore**, or set it yourself in Settings → Display. |
| Launches from other devices can't be detected | Steam Link keeps working. Games launched from another Steam device may start before the resolution changes.           |

Any of these probably means a Steam update changed something. Please [open an issue](https://github.com/murphmar/decky-gaugeshift/issues/new/choose).

## How it works

- **Stream start and stop:** Steam's `SteamClient.RemotePlay.RegisterForSettingsChanges` reports the streaming client's name (`strStreamingClientName`) when a stream starts and stops.
- **Remote launches:** these skip Steam's own UI on the host, so the backend watches Steam's `console_log.txt` for the first line of each new launch. The frontend treats a launch as remote when Steam's UI didn't start it (`SteamClient.Apps.RegisterForGameActionStart`) and nothing is streaming yet.
- **Detection health check:** if Steam's UI starts a launch and the log watcher doesn't report it within 15 seconds, the panel warns that remote-launch detection isn't working.
- **Changing the setting:** `SteamClient.Settings.SetSetting` writes the setting (`gamescope_game_resolution_global`), and `settingsStore` provides the current value.
- **Saved state:** the rules and pending-restore state are kept in `~/homebrew/settings/<plugin>/config.json`. Logs are in `~/homebrew/logs/<plugin>/`.

None of these Steam APIs are officially documented, so a Steam update could break something. If it stops working, please [open an issue](https://github.com/murphmar/decky-gaugeshift/issues) and attach the plugin log.

## Development

You need Node.js 22 with pnpm 9, Python 3.11+ (for the backend tests), and `zip`.

```sh
pnpm install
pnpm check            # typecheck, format check, tests, build
pnpm coverage         # frontend tests with a coverage report
pip install pytest ruff
ruff check . && pytest tests/backend
./package.sh          # writes out/gaugeshift.zip
```

- `src/engine.ts` makes all the decisions and doesn't touch Steam directly. It's tested in `tests/frontend` against a simulated Steam.
- `src/steam.ts` and `src/host.ts` connect the engine to Steam and to the backend.
- `main.py` stores settings and watches Steam's log. It's tested in `tests/backend`.

Every push and pull request runs all the checks. To release, add the version to `CHANGELOG.md`, bump `version` in `package.json`, then push a tag such as `v0.5.0`. The release only builds if every check passes.

## License

BSD 3-Clause. See [LICENSE](LICENSE). Based on the [Decky plugin template](https://github.com/SteamDeckHomebrew/decky-plugin-template).

Not affiliated with or endorsed by Valve. Steam, Steam Deck, Steam Link and Remote Play are trademarks of Valve Corporation.
