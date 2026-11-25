"""Gaugeshift - backend.

Stores the user's per-device rules and the restore state on disk, so the
original Maximum Game Resolution can be put back even if Steam or the
plugin restarts in the middle of a stream.

The frontend does the actual work (it runs inside Steam and can read and
change the setting); this side only persists data.
"""

import asyncio
import json
import os
import re
import tempfile
import time

import decky

CONFIG_VERSION = 1

# Steam writes one of these lines for every step of every game launch. The
# first line for a new ActionID is the earliest sign that a launch started,
# several seconds before the game process exists.
LAUNCH_LINE = re.compile(
    r"GameAction \[AppID (\d+), ActionID (\d+)\] : LaunchApp changed task to"
)


def _default_config() -> dict:
    return {
        "version": CONFIG_VERSION,
        "enabled": True,
        # device name -> resolution value ("1920x1200", "Native", ...).
        # A device with no entry is left alone.
        "rules": {},
        # device name -> unix time it last streamed from this machine
        "devices": {},
        # Present only while a stream has changed the setting.
        "session": None,
    }


class Plugin:
    def __init__(self):
        self.path = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "config.json")
        self.config = _default_config()

    # ---- persistence -------------------------------------------------

    def _load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return
        except (OSError, ValueError) as exc:
            decky.logger.error(f"Could not read {self.path}: {exc}; using defaults")
            return

        config = _default_config()
        if isinstance(data, dict):
            config["enabled"] = bool(data.get("enabled", True))
            if isinstance(data.get("rules"), dict):
                config["rules"] = {
                    str(k): str(v) for k, v in data["rules"].items() if v
                }
            if isinstance(data.get("devices"), dict):
                config["devices"] = {
                    str(k): float(v)
                    for k, v in data["devices"].items()
                    if isinstance(v, (int, float))
                }
            session = data.get("session")
            if isinstance(session, dict) and session.get("previous"):
                config["session"] = {
                    "device": str(session.get("device", "")),
                    "previous": str(session["previous"]),
                    "applied": str(session.get("applied", "")),
                    "started": float(session.get("started", 0) or 0),
                }
        self.config = config

    def _save(self) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        # Write to a temp file and rename, so a crash can't leave a
        # half-written config behind.
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self.config, f, indent=2, sort_keys=True)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    # ---- methods called from the frontend ---------------------------

    async def get_config(self) -> dict:
        return self.config

    async def set_enabled(self, enabled: bool) -> dict:
        self.config["enabled"] = bool(enabled)
        self._save()
        decky.logger.info(f"Enabled: {self.config['enabled']}")
        return self.config

    async def set_rule(self, device: str, resolution: str) -> dict:
        device = str(device)
        if resolution:
            self.config["rules"][device] = str(resolution)
        else:
            self.config["rules"].pop(device, None)
        self._save()
        decky.logger.info(f"Rule for {device!r}: {resolution or 'no change'}")
        return self.config

    async def note_device(self, device: str) -> dict:
        if device:
            self.config["devices"][str(device)] = time.time()
            self._save()
        return self.config

    async def forget_device(self, device: str) -> dict:
        self.config["devices"].pop(str(device), None)
        self.config["rules"].pop(str(device), None)
        self._save()
        return self.config

    async def begin_session(self, device: str, previous: str, applied: str) -> dict:
        # Keep the original "previous" value if a session is already
        # recorded, so a restart mid-stream never loses the real original.
        existing = self.config.get("session")
        if existing and existing.get("previous"):
            previous = existing["previous"]
        self.config["session"] = {
            "device": str(device),
            "previous": str(previous),
            "applied": str(applied),
            "started": time.time(),
        }
        self._save()
        decky.logger.info(f"Session: {device!r} set {applied!r}, will restore {previous!r}")
        return self.config

    async def end_session(self) -> dict:
        if self.config.get("session"):
            decky.logger.info("Session ended, restore state cleared")
        self.config["session"] = None
        self._save()
        return self.config

    async def log(self, level: str, message: str) -> None:
        getattr(decky.logger, level if level in ("info", "warning", "error") else "info")(
            f"[frontend] {message}"
        )

    # ---- lifecycle ---------------------------------------------------

    # ---- launch watcher ----------------------------------------------

    async def _watch_launches(self):
        """Tails Steam's console log and tells the frontend about new launches.

        Launches requested by a remote device (for example a Steam Deck
        choosing "Stream" in its library) don't go through the Steam UI on
        this machine, so this log is the only early signal for them.
        """
        path = os.path.join(
            decky.DECKY_USER_HOME, ".local", "share", "Steam", "logs", "console_log.txt"
        )
        seen: list[str] = []
        f = None
        inode = None
        while True:
            try:
                if f is None:
                    f = open(path, "r", encoding="utf-8", errors="replace")
                    inode = os.fstat(f.fileno()).st_ino
                    f.seek(0, os.SEEK_END)
                st = os.stat(path)
                if st.st_ino != inode or st.st_size < f.tell():
                    # Steam rotated or truncated the log; start the new one.
                    f.close()
                    f = open(path, "r", encoding="utf-8", errors="replace")
                    inode = os.fstat(f.fileno()).st_ino
                while True:
                    line = f.readline()
                    if not line:
                        break
                    m = LAUNCH_LINE.search(line)
                    if not m:
                        continue
                    app_id, action_id = m.group(1), m.group(2)
                    key = f"{app_id}:{action_id}"
                    if key in seen:
                        continue
                    seen.append(key)
                    del seen[:-50]
                    decky.logger.info(f"Launch started: app {app_id}, action {action_id}")
                    await decky.emit("launch_started", int(app_id), int(action_id))
            except FileNotFoundError:
                if f:
                    f.close()
                f = None
                await asyncio.sleep(2)
            except Exception as exc:  # keep watching no matter what
                decky.logger.error(f"Launch watcher error: {exc}")
                if f:
                    f.close()
                f = None
                await asyncio.sleep(2)
            await asyncio.sleep(0.1)

    async def _migration(self):
        # Version 0.3 and earlier were installed as "remote-play-resolution";
        # carry the user's rules and any pending restore over to the new name.
        # Only when Gaugeshift has no config of its own yet, so an old copy
        # can never overwrite newer settings.
        old = os.path.join(decky.DECKY_HOME, "settings", "remote-play-resolution", "config.json")
        new = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "config.json")
        if os.path.exists(old) and not os.path.exists(new):
            decky.migrate_settings(old)

    async def _main(self):
        self._load()
        decky.logger.info(f"Loaded config from {self.path}")
        self._watcher = asyncio.get_event_loop().create_task(self._watch_launches())

    async def _unload(self):
        watcher = getattr(self, "_watcher", None)
        if watcher:
            watcher.cancel()
        decky.logger.info("Unloading")

    async def _uninstall(self):
        # The frontend restores the setting when it unloads; nothing to
        # clean up here beyond the settings file Decky removes itself.
        decky.logger.info("Uninstalled")
