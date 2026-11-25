# Testing

Gaugeshift is checked in two ways: automated tests that run on GitHub for every change, and a checklist run by hand on real hardware before each release.

## Automated tests

| Suite                           | What it covers                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/frontend/engine.test.ts` | Every situation the engine handles: connecting and disconnecting, switching devices, rule changes mid-stream, turning it off and on, manual changes, restarts, launches from other devices (right guess, wrong guess, no stream), failures and retries, and the launch-detection health check                                                                                                                   |
| `tests/frontend/edge.test.ts`   | Rarer paths: errors thrown in unexpected places, ties when guessing a device, an unreadable setting after a failed change                                                                                                                                                                                                                                                                                       |
| `tests/frontend/stress.test.ts` | **Randomized stress tests.** Thousands of random sequences of events, including restarts, crashes, manual changes and Steam refusing changes. After every step they check Gaugeshift's promises: while a device streams, the setting follows its rule, and once nothing streams, the setting is back where the user left it. When a sequence breaks a promise, it's shrunk to the shortest one that still does. |
| `tests/frontend/steam.test.ts`  | The Steam adapter against a pretend Steam client: encoding the setting, reading it safely, confirming changes, and coping with missing or odd data from Steam                                                                                                                                                                                                                                                   |
| `tests/backend/`                | Settings validation; loading missing, corrupt or truncated files; saves that fail halfway; migration from the old plugin name; and the log watcher with Steam rotating, truncating or deleting its log, or caught mid-write                                                                                                                                                                                     |

There are minimum coverage levels, and the build fails if coverage drops below them. To check the tests really catch problems, we deliberately introduced four different bugs into the engine, and the stress tests caught every one.

Run everything locally with `pnpm check` and `pytest tests/backend` (see the [README](../README.md#development)).

## Hardware checklist

Run on a machine with Decky Loader, streaming to at least one Steam Link device (phone, tablet or TV) and one Steam device (such as a Steam Deck). Before starting:

- Set **Settings → Display → Maximum Game Resolution** to something other than Default, such as 1920x1080. That way you can tell a real restore from a reset to Default.
- Give each device a rule that's easy to spot, such as 1920x1200.

| #   | Test                          | Steps                                                                               | Expected                                                                                                                             |
| --- | ----------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Steam Link connect            | Connect from Steam Link                                                             | Notification shows the full resolution ("Maximum Resolution: 1920x1200"); panel shows "Streaming to …"; setting is the device's rule |
| 2   | Game runs at the rule         | While connected over Steam Link, launch a game and check its resolution             | The device's rule                                                                                                                    |
| 3   | Steam Link disconnect         | Stop streaming                                                                      | Setting is back to its earlier value (not Default)                                                                                   |
| 4   | Rule change mid-stream        | While connected, change the device's rule in the panel                              | Setting changes at once; disconnecting still restores the original value                                                             |
| 5   | Steam Deck launch             | On the Deck, choose **Stream** on a game from the machine's library                 | Game starts at the Deck's rule; log shows "launched remotely" before the game starts                                                 |
| 6   | Local launch with Deck online | Deck on and idle; launch a game on the machine itself                               | Nothing changes; log shows "launched from this machine's UI"                                                                         |
| 7   | "Don't change"                | Set a device to Don't change and connect it                                         | Nothing changes                                                                                                                      |
| 8   | Custom resolution             | Choose **Custom…**, try an invalid value, then enter `2560x1080`                    | Save stays disabled until the value is valid; the custom value appears in the list and is used                                       |
| 9   | Manual change mid-stream      | While streaming, change the setting yourself in Settings → Display, then disconnect | Your value is kept                                                                                                                   |
| 10  | Turn off mid-stream           | While streaming, switch Gaugeshift off                                              | Setting restored at once                                                                                                             |
| 11  | Update mid-stream             | While streaming, install a newer build                                              | Old version restores; new version re-applies the rule                                                                                |
| 12  | Steam restart mid-stream      | While streaming, restart Steam (Power → Restart Steam)                              | After restart, the setting is restored (stream ended) or the rule is applied (stream still running)                                  |
| 13  | Reboot mid-stream             | While streaming, reboot the machine                                                 | After reboot, the setting is restored                                                                                                |
| 14  | Sleep mid-stream              | While streaming, put the machine to sleep, then wake it                             | Setting restored once the stream has ended                                                                                           |
| 15  | Uninstall mid-stream          | While streaming, uninstall Gaugeshift                                               | Setting restored                                                                                                                     |
| 16  | Panel display                 | Open the panel while idle and while streaming                                       | Full resolutions visible (not cut off); status and Restore button correct                                                            |

## Results

### 0.5.0 (in progress)

**Setup:** Steam Machine, SteamOS 3.10.0 **Preview** (build 20261113.101), Steam client **Beta** (Nov 13 2026), Decky Loader 3.3.1. Streaming to an iPhone (Steam Link app) and a Steam Deck.

| #   | Result      | Notes                                                                                           |
| --- | ----------- | ----------------------------------------------------------------------------------------------- |
| 1   | ✅ Pass     | 2026-11-24                                                                                      |
| 2   | ✅ Pass     | Earlier version (0.2.0), same behavior: The Witcher 3 ran at 1920x1200. To re-run on 0.5.0      |
| 3   | ✅ Pass     | Restored 1920x1080                                                                              |
| 4   | ✅ Pass     | Earlier version (0.2.0); to re-run on 0.5.0                                                     |
| 5   | ✅ Pass     | Earlier version (0.3.0): rule applied 3.5 s before the game process started. To re-run on 0.5.0 |
| 6   | ✅ Pass     | Earlier version (0.3.0); to re-run on 0.5.0                                                     |
| 7   | ✅ Pass     | Earlier version (0.1.0); to re-run on 0.5.0                                                     |
| 8   | Not yet run |                                                                                                 |
| 9   | Not yet run |                                                                                                 |
| 10  | Not yet run |                                                                                                 |
| 11  | ✅ Pass     | Updating from 0.4.0 to 0.5.0 while connected                                                    |
| 12  | Not yet run |                                                                                                 |
| 13  | Not yet run |                                                                                                 |
| 14  | Not yet run |                                                                                                 |
| 15  | Not yet run |                                                                                                 |
| 16  | ✅ Pass     | After fixing cut-off dropdowns; see the screenshot in the README                                |

**Still needed before 1.0:** the remaining rows on 0.5.0, and a run on SteamOS **Stable** with the Stable Steam client.
