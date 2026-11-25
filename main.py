"""Gaugeshift backend.

The frontend (which runs inside Steam) makes all the decisions. This side:

* stores the settings, validating everything it is given and writing
  atomically, so a crash can never leave a broken file behind;
* watches Steam's console log for game launches. Launches requested by a
  remote Steam client (such as a Steam Deck choosing "Stream") don't go
  through the Steam UI on this machine, so the log is the earliest place
  they show up.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile

import decky

CONFIG_VERSION = 1

# Values Gaugeshift may set: "Native" or WIDTHxHEIGHT.
RULE_RE = re.compile(r"^(Native|[1-9][0-9]{2,4}x[1-9][0-9]{2,4})$")

# Steam writes one of these for every step of every launch. The first line
# for a new ActionID is the earliest sign of a launch, seconds before the
# game process exists.
LAUNCH_RE = re.compile(r"GameAction \[AppID (\d+), ActionID (\d+)\] : LaunchApp changed task to")


def default_config() -> dict:
    return {
        "version": CONFIG_VERSION,
        "enabled": True,
        "rules": {},
        "devices": {},
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


class LaunchWatcher:
    """Reports game launches written to Steam's console log.

    Call `poll()` regularly; it returns the (app_id, action_id) of launches
    that started since the last call. Copes with the log being missing,
    rotated, truncated, or caught mid-write.
    """

    def __init__(self, path: str):
        self.path = path
        self._file = None
        self._inode = None
        self._opened_before = False
        self._partial = ""
        self._seen: list[tuple[int, int]] = []

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
            # Skip launches that happened before we started watching.
            f.seek(0, os.SEEK_END)
            self._opened_before = True
        return True

    def poll(self) -> list[tuple[int, int]]:
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
            launches = self._read_lines()
            self.close()
            if self._open():
                launches += self._read_lines()
            return launches
        if st.st_size < self._file.tell():
            self._file.seek(0)
            self._partial = ""
        return self._read_lines()

    def _read_lines(self) -> list[tuple[int, int]]:
        launches = []
        while True:
            chunk = self._file.readline()
            if not chunk:
                break
            if not chunk.endswith("\n"):
                # Steam is mid-write; finish the line on a later poll.
                self._partial += chunk
                break
            line = self._partial + chunk
            self._partial = ""
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


class Plugin:
    def __init__(self):
        self.config = default_config()
        self.config_path = ""
        self._watcher_task = None

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

    async def log(self, level: str, message: str) -> None:
        log = {"warning": decky.logger.warning, "error": decky.logger.error}.get(level, decky.logger.info)
        log(f"[frontend] {message}")

    # ---- log watcher -----------------------------------------------------

    async def _watch_launches(self, path: str, interval: float = 0.1) -> None:
        watcher = LaunchWatcher(path)
        try:
            while True:
                try:
                    for app_id, action_id in watcher.poll():
                        decky.logger.info(f"Launch started: app {app_id}, action {action_id}")
                        await decky.emit("launch_started", app_id, action_id)
                except Exception as exc:  # keep watching whatever happens
                    decky.logger.error(f"Launch watcher error: {exc!r}")
                    watcher.close()
                    await asyncio.sleep(2)
                await asyncio.sleep(interval)
        finally:
            watcher.close()

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
        log_path = os.path.join(decky.DECKY_USER_HOME, ".local", "share", "Steam", "logs", "console_log.txt")
        self._watcher_task = asyncio.get_event_loop().create_task(self._watch_launches(log_path))

    async def _unload(self):
        if self._watcher_task:
            self._watcher_task.cancel()
        decky.logger.info("Unloaded")

    async def _uninstall(self):
        decky.logger.info("Uninstalled")
