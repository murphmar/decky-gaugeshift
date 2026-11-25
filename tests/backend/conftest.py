"""Test setup: a stand-in for the `decky` module that Decky Loader provides."""

import logging
import os
import shutil
import sys
import types

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def decky(tmp_path, monkeypatch):
    home = tmp_path / "home"
    decky_home = home / "homebrew"
    settings = decky_home / "settings" / "gaugeshift"
    settings.mkdir(parents=True)

    mod = types.ModuleType("decky")
    mod.DECKY_USER_HOME = str(home)
    mod.DECKY_HOME = str(decky_home)
    mod.DECKY_PLUGIN_SETTINGS_DIR = str(settings)
    mod.logger = logging.getLogger("gaugeshift-test")
    mod.emitted = []

    async def emit(event, *args):
        mod.emitted.append((event, *args))

    def migrate_settings(*paths):
        moved = {}
        for p in paths:
            if os.path.isfile(p):
                dest = os.path.join(mod.DECKY_PLUGIN_SETTINGS_DIR, os.path.basename(p))
                shutil.move(p, dest)
                moved[p] = dest
        return moved

    mod.emit = emit
    mod.migrate_settings = migrate_settings
    monkeypatch.setitem(sys.modules, "decky", mod)
    monkeypatch.syspath_prepend(ROOT)
    sys.modules.pop("main", None)
    yield mod
    sys.modules.pop("main", None)


@pytest.fixture
def main(decky):
    import main as module

    return module
