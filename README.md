# Gaugeshift

**Per-device game resolution for Remote Play and Steam Link.**

Gaugeshift is a [Decky Loader](https://decky.xyz) plugin for SteamOS machines that you stream _from_, such as a Steam Machine or a Steam Deck sitting in its dock. When a device starts streaming from it, Gaugeshift changes Steam's **Maximum Game Resolution** to the size you picked for that device. When the device disconnects, Gaugeshift puts the setting back to whatever it was before.

Like a train changing gauge at a border, your games re-fit themselves to whichever screen they're heading to.

<p align="center">
  <img src="docs/images/panel-streaming.png" width="380" alt="The Gaugeshift panel in the Quick Access Menu while an iPhone is streaming: Maximum Game Resolution is set to 1920x1200 and will be restored to 1920x1080 afterwards. Below, each device has its own resolution.">
</p>

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

Gaugeshift listens to Steam's own Remote Play events to see which device is streaming. It also reads Steam's console log to catch launches requested by another Steam device, a few seconds before the game starts. It changes the setting through Steam's own settings function, and saves what to restore _before_ changing anything.

[ARCHITECTURE.md](ARCHITECTURE.md) explains the code in plain terms: what each part does, what happens in each situation, and why. None of the Steam functions Gaugeshift relies on are officially documented, so a Steam update could break something. If that happens, Gaugeshift warns you in its panel and leaves the setting alone.

## Safety

Gaugeshift doesn't need root, never uses the network, can't run other programs, and only touches one Steam setting, its own settings file, and Steam's log (read-only). Every change it makes is undone. An automated check enforces these limits on every build. Releases are built on GitHub from the source code, and you can verify that a download matches its release. See [SECURITY.md](SECURITY.md) for the details.

## How this was made

Gaugeshift was built by Mark with substantial help from an AI coding assistant (Claude, by Anthropic), which wrote most of the code under Mark's direction and review. That's why it isn't in the Decky Plugin Store, which doesn't accept AI-written code.

We know AI-written plugins have a reputation for being hard to trust, so here is what was done about that:

- **Every behavior is tested.** About 130 automated tests run on every change. They include randomized stress tests that try thousands of random sequences of events, and they're checked against deliberately broken versions of the code to make sure they catch real bugs. See [docs/TESTING.md](docs/TESTING.md).
- **It's tested on real hardware** before every release, against a written checklist, with the results published.
- **Its abilities are locked down** and checked automatically: see [Safety](#safety).
- **The code is documented** so anyone can review it, and so it can be maintained without the tool that helped write it: see [ARCHITECTURE.md](ARCHITECTURE.md).

If you find something wrong, please [open an issue](https://github.com/murphmar/decky-gaugeshift/issues/new/choose).

## Support and maintenance

- **Last tested on:** SteamOS 3.10.0 (Preview) with the Steam client Beta of November 2026, and Decky Loader 3.3.1. The [test results](docs/TESTING.md#results) list the details for each release.
- **Steam updates:** Steam updates can change the undocumented functions Gaugeshift relies on. Gaugeshift is designed to fail safely when that happens: it warns you and changes nothing. Fixes for breakage like this get priority.
- **Problems:** please use the [bug report form](https://github.com/murphmar/decky-gaugeshift/issues/new/choose), and attach the Gaugeshift log it asks for.
- **Security problems:** see [SECURITY.md](SECURITY.md#reporting-a-security-problem).

## Development

You need Node.js 22, Python 3.11+ (for the backend tests), and `zip`. Run `corepack enable` once so `pnpm` is the exact version pinned in `package.json` (pnpm 9, which Decky's tooling expects).

```sh
pnpm install
pnpm check            # types, formatting, tests (with coverage), build, safety check, audit
pnpm coverage         # frontend tests with a coverage report
pip install pytest pytest-cov ruff
ruff check . && pytest tests/backend --cov=main
./package.sh          # writes out/gaugeshift.zip
```

- `src/engine.ts` makes all the decisions and doesn't touch Steam directly. It's tested in `tests/frontend` against a simulated Steam.
- `src/steam.ts` and `src/host.ts` connect the engine to Steam and to the backend.
- `main.py` stores settings and watches Steam's log. It's tested in `tests/backend`.
- [ARCHITECTURE.md](ARCHITECTURE.md) explains how it all fits together, and [docs/TESTING.md](docs/TESTING.md) describes the tests and the hardware checklist.

Every push and pull request runs all the checks. To release, add the version to `CHANGELOG.md`, bump `version` in `package.json`, then push a tag such as `v0.5.0`. The release only builds if every check passes.

## License

BSD 3-Clause. See [LICENSE](LICENSE). Based on the [Decky plugin template](https://github.com/SteamDeckHomebrew/decky-plugin-template).

Not affiliated with or endorsed by Valve. Steam, Steam Deck, Steam Link and Remote Play are trademarks of Valve Corporation.
