import asyncio
import json
import os

import pytest


def run(coro):
    return asyncio.run(coro)


# ---- normalize_config -------------------------------------------------------


def test_defaults_for_garbage(main):
    for data in (None, [], "x", 3, {"enabled": "yes"}):
        assert main.normalize_config(data) == main.default_config()


def test_keeps_valid_values(main):
    data = {
        "version": 2,
        "enabled": False,
        "newDevices": "None",
        "rules": {"steamdeck": "1920x1200", "TV": "Native", "iPhone": "Match", "Tablet": "None"},
        "devices": {"steamdeck": 1795564389300, "iPhone": 0},
        "screens": {"steamdeck": "1280x800", "iPhone": "2001x1125"},
        "session": {"device": "steamdeck", "previous": "Default", "applied": "1920x1200", "started": 10},
    }
    assert main.normalize_config(data) == data


@pytest.mark.parametrize(
    "value",
    [
        "",
        "Default",
        "match",
        "none",
        "1920",
        "1920x",
        "x1080",
        "01920x1080",
        "1920x1080x2",
        "abc",
        " 1920x1080",
        1920,
        None,
    ],
)
def test_drops_invalid_rules(main, value):
    config = main.normalize_config({"rules": {"dev": value, "ok": "1280x800"}})
    assert config["rules"] == {"ok": "1280x800"}


def test_drops_invalid_devices(main):
    config = main.normalize_config(
        {"devices": {"a": 1, "b": "1", "c": True, "d": float("nan"), "e": float("inf"), "": 3, "f": 2.5}}
    )
    assert config["devices"] == {"a": 1000, "f": 2500}


def test_converts_old_second_timestamps_to_ms(main):
    config = main.normalize_config({"devices": {"old": 1795564389.3, "new": 1795564389300}})
    assert config["devices"] == {"old": 1795564389300.0, "new": 1795564389300}


@pytest.mark.parametrize(
    "session",
    [
        {"device": "d", "previous": "", "applied": "1920x1200"},
        {"device": "d", "previous": "Default"},
        {"previous": "Default", "applied": "1920x1200"},
        {"device": 3, "previous": "Default", "applied": "1920x1200"},
        "nope",
    ],
)
def test_drops_incomplete_sessions(main, session):
    assert main.normalize_config({"session": session})["session"] is None


def test_session_started_defaults_to_zero(main):
    config = main.normalize_config({"session": {"device": "d", "previous": "Default", "applied": "1280x800"}})
    assert config["session"]["started"] == 0


# ---- load / save ------------------------------------------------------------


def test_load_missing_file(main, tmp_path):
    assert main.load_config(str(tmp_path / "nope.json")) == main.default_config()


def test_load_corrupt_file(main, tmp_path):
    path = tmp_path / "config.json"
    path.write_text("{not json")
    assert main.load_config(str(path)) == main.default_config()


def test_load_truncated_file(main, tmp_path):
    path = tmp_path / "config.json"
    path.write_text('{"enabled": false, "rules": {"a": "1280x8')
    assert main.load_config(str(path)) == main.default_config()


def test_save_then_load_roundtrip(main, decky):
    plugin = main.Plugin()
    saved = run(plugin.save_config({"enabled": False, "rules": {"steamdeck": "1920x1200", "bad": "huge"}}))
    assert saved["rules"] == {"steamdeck": "1920x1200"}
    assert run(plugin.get_config()) == saved
    assert main.load_config(plugin._path) == saved


def test_save_leaves_no_temp_files(main, decky):
    plugin = main.Plugin()
    run(plugin.save_config({"rules": {"a": "1280x800"}}))
    run(plugin.save_config({"rules": {"a": "1920x1080"}}))
    assert os.listdir(decky.DECKY_PLUGIN_SETTINGS_DIR) == ["config.json"]


def test_failed_save_keeps_old_file(main, decky, monkeypatch):
    plugin = main.Plugin()
    run(plugin.save_config({"rules": {"a": "1280x800"}}))
    before = open(plugin._path).read()

    def boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(main.json, "dump", boom)
    with pytest.raises(OSError):
        run(plugin.save_config({"rules": {"a": "1920x1080"}}))
    assert open(plugin._path).read() == before
    assert os.listdir(decky.DECKY_PLUGIN_SETTINGS_DIR) == ["config.json"]
    assert plugin.config["rules"] == {"a": "1280x800"}


def test_main_loads_saved_settings(main, decky):
    path = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "config.json")
    with open(path, "w") as f:
        json.dump({"rules": {"iPhone": "1920x1080"}}, f)

    async def go():
        plugin = main.Plugin()
        await plugin._main()
        await plugin._unload()
        return plugin

    assert run(go()).config["rules"] == {"iPhone": "1920x1080"}


# ---- migration from "remote-play-resolution" --------------------------------


def _old_path(decky):
    path = os.path.join(decky.DECKY_HOME, "settings", "remote-play-resolution", "config.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def test_migrates_old_settings(main, decky):
    old = _old_path(decky)
    with open(old, "w") as f:
        json.dump({"rules": {"steamdeck": "1920x1200"}}, f)
    plugin = main.Plugin()
    run(plugin._migration())
    assert main.load_config(plugin._path)["rules"] == {"steamdeck": "1920x1200"}
    assert not os.path.exists(old)


def test_migration_never_overwrites_new_settings(main, decky):
    old = _old_path(decky)
    with open(old, "w") as f:
        json.dump({"rules": {"steamdeck": "1280x800"}}, f)
    plugin = main.Plugin()
    run(plugin.save_config({"rules": {"steamdeck": "1920x1200"}}))
    run(plugin._migration())
    assert main.load_config(plugin._path)["rules"] == {"steamdeck": "1920x1200"}
    assert os.path.exists(old)


def test_migration_without_old_settings(main, decky):
    plugin = main.Plugin()
    run(plugin._migration())
    assert not os.path.exists(plugin._path)


# ---- version 2: Match screen and the New devices default -------------------


def test_new_devices_default_to_match(main):
    assert main.default_config()["newDevices"] == "Match"
    assert main.normalize_config({"version": 2})["newDevices"] == "Match"


@pytest.mark.parametrize("value", ["Match", "None"])
def test_keeps_new_devices_setting(main, value):
    assert main.normalize_config({"version": 2, "newDevices": value})["newDevices"] == value


@pytest.mark.parametrize("value", ["", "match", "Native", "1280x800", 3, None])
def test_drops_invalid_new_devices_setting(main, value):
    assert main.normalize_config({"version": 2, "newDevices": value})["newDevices"] == "Match"


def test_drops_invalid_screens(main):
    config = main.normalize_config(
        {"version": 2, "screens": {"deck": "1280x800", "bad": "huge", "n": "Native", "": "1280x800", "x": 5}}
    )
    assert config["screens"] == {"deck": "1280x800"}


def test_migration_keeps_known_devices_unchanged(main):
    # Version 1 left devices without a rule alone; they must stay that way
    # now that new devices match their screen by default.
    old = {
        "version": 1,
        "rules": {"steamdeck": "1920x1200"},
        "devices": {"steamdeck": 1795564389300, "iPhone": 1795564389300},
    }
    config = main.normalize_config(old)
    assert config["rules"] == {"steamdeck": "1920x1200", "iPhone": "None"}
    assert config["newDevices"] == "Match"
    assert config["version"] == 2


def test_migration_without_version_number(main):
    config = main.normalize_config({"devices": {"iPhone": 5}})
    assert config["rules"] == {"iPhone": "None"}


def test_no_migration_for_version_2(main):
    config = main.normalize_config({"version": 2, "devices": {"iPhone": 5}})
    assert config["rules"] == {}
