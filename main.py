"""Gaugeshift backend.

The frontend (which runs inside Steam) makes all the decisions. This side:

* stores the settings, validating everything it is given and writing
  atomically, so a crash can never leave a broken file behind;
* watches Steam's console log for game launches. Launches requested by a
  remote Steam client (such as a Steam Deck choosing "Stream") don't go
  through the Steam UI on this machine, so the log is the earliest place
  they show up;
* watches Steam's streaming log for the screen size each streaming device
  reports, so "Match screen" knows what to use.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile

import decky

CONFIG_VERSION = 2

# A device's rule: "Match" (its own screen size), "None" (don't change),
# "Native", or WIDTHxHEIGHT.
RESOLUTION_RE = re.compile(r"^[1-9][0-9]{2,4}x[1-9][0-9]{2,4}$")
RULE_RE = re.compile(r"^(Match|None|Native|[1-9][0-9]{2,4}x[1-9][0-9]{2,4})$")
NEW_DEVICE_RULES = ("Match", "None")

# Steam writes one of these for every step of every launch. The first line
# for a new ActionID is the earliest sign of a launch, seconds before the
# game process exists.
LAUNCH_RE = re.compile(r"GameAction \[AppID (\d+), ActionID (\d+)\] : LaunchApp changed task to")

# In Steam's streaming log: which device a stream is going to, and the screen
# size that device reports a moment later.
STREAM_START_RE = re.compile(r"Streaming started to (.+?) at \S+")
SCREEN_RE = re.compile(r"CLIENT: Video size: \d+x\d+, output size: (\d+)x(\d+)")


def default_config() -> dict:
    return {
        "version": CONFIG_VERSION,
        "enabled": True,
        # What a device with no rule of its own gets.
        "newDevices": "Match",
        "rules": {},
        "devices": {},
        # Device name -> screen size it reported, e.g. "1280x800".
        "screens": {},
        "session": None,
    }


def _number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value in (float("inf"), float("-inf")):  # NaN / inf
        return None
    return value


def _to_ms(timestamp: float) -> float:
    """Times are stored in milliseconds; versions up to 0.4 stored seconds."""
    return timestamp * 1000 if 0 < timestamp < 100_000_000_000 else timestamp


def normalize_config(data) -> dict:
    """Returns a valid config built from `data`, dropping anything invalid."""
    config = default_config()
    if not isinstance(data, dict):
        return config

    if isinstance(data.get("enabled"), bool):
        config["enabled"] = data["enabled"]

    rules = data.get("rules")
    if isinstance(rules, dict):
        config["rules"] = {
            name: value
            for name, value in rules.items()
            if isinstance(name, str) and name and isinstance(value, str) and RULE_RE.match(value)
        }

    devices = data.get("devices")
    if isinstance(devices, dict):
        config["devices"] = {
            name: _to_ms(seen)
            for name, seen in ((n, _number(v)) for n, v in devices.items())
            if isinstance(name, str) and name and seen is not None
        }

    if data.get("newDevices") in NEW_DEVICE_RULES:
        config["newDevices"] = data["newDevices"]

    screens = data.get("screens")
    if isinstance(screens, dict):
        config["screens"] = {
            name: size
            for name, size in screens.items()
            if isinstance(name, str) and name and isinstance(size, str) and RESOLUTION_RE.match(size)
        }

    # Before version 2, a device without a rule was left alone. New devices
    # now match their screen by default, so keep every device that was
    # already known exactly as it was.
    version = data.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 2:
        for name in config["devices"]:
            config["rules"].setdefault(name, "None")

    session = data.get("session")
    if isinstance(session, dict):
        previous = session.get("previous")
        applied = session.get("applied")
        device = session.get("device")
        if all(isinstance(v, str) and v for v in (previous, applied, device)):
            config["session"] = {
                "device": device,
                "previous": previous,
                "applied": applied,
                "started": _number(session.get("started")) or 0,
            }
    return config


def write_json_atomic(path: str, data: dict) -> None:
    """Writes `data` to `path` so readers only ever see the old or new file."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".config-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_config(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            return normalize_config(json.load(f))
    except FileNotFoundError:
        return default_config()
    except (OSError, ValueError) as exc:
        decky.logger.error(f"Couldn't read {path} ({exc}); starting with default settings")
        return default_config()


class LogFollower:
    """Follows a log file like `tail -F`, returning complete new lines.

    Copes with the log being missing, rotated (renamed and replaced),
    truncated, deleted, or caught mid-write.
    """

    def __init__(self, path: str):
        self.path = path
        self._file = None
        self._inode = None
        self._opened_before = False
        self._partial = ""

    def close(self) -> None:
        if self._file:
            self._file.close()
        self._file = None
        self._partial = ""

    def _open(self) -> bool:
        try:
            f = open(self.path, encoding="utf-8", errors="replace")
        except FileNotFoundError:
            # The log doesn't exist yet: when it appears, everything in it
            # is new, so read it from the start.
            self._opened_before = True
            return False
        self._file = f
        self._inode = os.fstat(f.fileno()).st_ino
        self._partial = ""
        if not self._opened_before:
            # Skip what happened before we started watching.
            f.seek(0, os.SEEK_END)
            self._opened_before = True
        return True

    def new_lines(self) -> list[str]:
        if self._file is None and not self._open():
            return []
        try:
            st = os.stat(self.path)
        except FileNotFoundError:
            self.close()
            return []
        if st.st_ino != self._inode:
            # Steam started a new log (it renames the old one); read it from
            # the beginning, after finishing what's left of the old one.
            lines = self._read()
            self.close()
            if self._open():
                lines += self._read()
            return lines
        if st.st_size < self._file.tell():
            self._file.seek(0)
            self._partial = ""
        return self._read()

    def _read(self) -> list[str]:
        lines = []
        while True:
            chunk = self._file.readline()
            if not chunk:
                break
            if not chunk.endswith("\n"):
                # Steam is mid-write; finish the line on a later call.
                self._partial += chunk
                break
            lines.append(self._partial + chunk)
            self._partial = ""
        return lines


class LaunchWatcher:
    """Reports game launches written to Steam's console log.

    `poll()` returns the (app_id, action_id) of launches that started since
    the last call, each reported once.
    """

    def __init__(self, path: str):
        self._log = LogFollower(path)
        self._seen: list[tuple[int, int]] = []

    def close(self) -> None:
        self._log.close()

    def poll(self) -> list[tuple[int, int]]:
        launches = []
        for line in self._log.new_lines():
            m = LAUNCH_RE.search(line)
            if not m:
                continue
            launch = (int(m.group(1)), int(m.group(2)))
            if launch in self._seen:
                continue
            self._seen.append(launch)
            del self._seen[:-100]
            launches.append(launch)
        return launches


class ScreenWatcher:
    """Reports the screen size of each device that streams from this machine.

    Steam's streaming log names the device when a stream starts, and a
    moment later the device reports its screen ("output size"). `poll()`
    returns (device, "WIDTHxHEIGHT") once per stream.
    """

    def __init__(self, path: str):
        self._log = LogFollower(path)
        self._device: str | None = None

    def close(self) -> None:
        self._log.close()

    def poll(self) -> list[tuple[str, str]]:
        screens = []
        for line in self._log.new_lines():
            m = STREAM_START_RE.search(line)
            if m:
                self._device = m.group(1)
                continue
            m = SCREEN_RE.search(line)
            if m and self._device:
                width, height = int(m.group(1)), int(m.group(2))
                if 320 <= width <= 7680 and 200 <= height <= 4320:
                    screens.append((self._device, f"{width}x{height}"))
                    self._device = None  # once per stream
        return screens


def read_known_screens(paths: list[str]) -> dict[str, str]:
    """Screen sizes reported in existing streaming logs, oldest log first.

    Returns device -> "WIDTHxHEIGHT", keeping each device's latest report.
    Missing or unreadable logs are skipped.
    """
    screens: dict[str, str] = {}
    for path in paths:
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                device = None
                for line in f:
                    m = STREAM_START_RE.search(line)
                    if m:
                        device = m.group(1)
                        continue
                    m = SCREEN_RE.search(line)
                    if m and device:
                        width, height = int(m.group(1)), int(m.group(2))
                        if 320 <= width <= 7680 and 200 <= height <= 4320:
                            screens[device] = f"{width}x{height}"
                        device = None
        except OSError:
            continue
    return screens


class Plugin:
    def __init__(self):
        self.config = default_config()
        self.config_path = ""
        self._watcher_task = None

    @property
    def _logs_dir(self) -> str:
        return os.path.join(decky.DECKY_USER_HOME, ".local", "share", "Steam", "logs")

    @property
    def _path(self) -> str:
        return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "config.json")

    # ---- called from the frontend ----------------------------------------

    async def get_config(self) -> dict:
        return self.config

    async def save_config(self, config: dict) -> dict:
        new = normalize_config(config)
        write_json_atomic(self._path, new)
        self.config = new
        return new

    async def known_screens(self) -> dict[str, str]:
        """Screen sizes devices reported in earlier streams, from Steam's logs."""
        logs = self._logs_dir
        return read_known_screens(
            [os.path.join(logs, "streaming_log.previous.txt"), os.path.join(logs, "streaming_log.txt")]
        )

    async def log(self, level: str, message: str) -> None:
        log = {"warning": decky.logger.warning, "error": decky.logger.error}.get(level, decky.logger.info)
        log(f"[frontend] {message}")

    # ---- log watchers ----------------------------------------------------

    async def _watch_logs(self, console_log: str, streaming_log: str, interval: float = 0.1) -> None:
        launches = LaunchWatcher(console_log)
        screens = ScreenWatcher(streaming_log)
        try:
            while True:
                try:
                    for app_id, action_id in launches.poll():
                        decky.logger.info(f"Launch started: app {app_id}, action {action_id}")
                        await decky.emit("launch_started", app_id, action_id)
                    for device, size in screens.poll():
                        decky.logger.info(f"{device} reported a {size} screen")
                        await decky.emit("client_screen", device, size)
                except Exception as exc:  # keep watching whatever happens
                    decky.logger.error(f"Log watcher error: {exc!r}")
                    launches.close()
                    screens.close()
                    await asyncio.sleep(2)
                await asyncio.sleep(interval)
        finally:
            launches.close()
            screens.close()

    # ---- lifecycle -------------------------------------------------------

    async def _migration(self):
        # Up to 0.3 this plugin was called "remote-play-resolution". Carry its
        # settings over, but only if Gaugeshift has none of its own yet, so an
        # old copy can never overwrite newer settings.
        old = os.path.join(decky.DECKY_HOME, "settings", "remote-play-resolution", "config.json")
        if os.path.exists(old) and not os.path.exists(self._path):
            decky.migrate_settings(old)

    async def _main(self):
        self.config = load_config(self._path)
        decky.logger.info(f"Loaded settings from {self._path}")
        logs = self._logs_dir
        self._watcher_task = asyncio.get_event_loop().create_task(
            self._watch_logs(os.path.join(logs, "console_log.txt"), os.path.join(logs, "streaming_log.txt"))
        )

    async def _unload(self):
        if self._watcher_task:
            self._watcher_task.cancel()
        decky.logger.info("Unloaded")

    async def _uninstall(self):
        decky.logger.info("Uninstalled")
