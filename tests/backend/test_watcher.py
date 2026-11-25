import asyncio
import os

LINE = '[2026-11-24 20:19:13] GameAction [AppID {app}, ActionID {action}] : LaunchApp changed task to {task} with ""\n'


def launch(app, action, task="CheckShaderDepotManifest"):
    return LINE.format(app=app, action=action, task=task)


def append(path, text):
    with open(path, "a", encoding="utf-8") as f:
        f.write(text)


def test_ignores_launches_before_start(main, tmp_path):
    log = tmp_path / "console_log.txt"
    log.write_text(launch(1, 1))
    w = main.LaunchWatcher(str(log))
    assert w.poll() == []
    append(log, launch(2, 2))
    assert w.poll() == [(2, 2)]


def test_reports_each_launch_once(main, tmp_path):
    log = tmp_path / "console_log.txt"
    log.write_text("")
    w = main.LaunchWatcher(str(log))
    w.poll()
    append(log, launch(292030, 8) + launch(292030, 8, "ProcessingInstallScript") + "unrelated line\n")
    append(log, launch(292030, 8, "CreatingProcess") + launch(292030, 9))
    assert w.poll() == [(292030, 8), (292030, 9)]
    assert w.poll() == []


def test_partial_line_is_finished_later(main, tmp_path):
    log = tmp_path / "console_log.txt"
    log.write_text("")
    w = main.LaunchWatcher(str(log))
    w.poll()
    line = launch(42, 3)
    append(log, line[:30])
    assert w.poll() == []
    append(log, line[30:])
    assert w.poll() == [(42, 3)]


def test_missing_log_then_created(main, tmp_path):
    log = tmp_path / "console_log.txt"
    w = main.LaunchWatcher(str(log))
    assert w.poll() == []
    log.write_text(launch(5, 1))
    # The file is new, so everything in it counts.
    assert w.poll() == [(5, 1)]


def test_log_rotation(main, tmp_path):
    log = tmp_path / "console_log.txt"
    log.write_text("")
    w = main.LaunchWatcher(str(log))
    w.poll()
    append(log, launch(1, 1))
    os.rename(log, tmp_path / "console_log.previous.txt")
    log.write_text(launch(2, 2))
    # Finishes the old file, then reads the new one from the start.
    assert w.poll() == [(1, 1), (2, 2)]
    append(log, launch(3, 3))
    assert w.poll() == [(3, 3)]


def test_log_truncated(main, tmp_path):
    log = tmp_path / "console_log.txt"
    log.write_text("x" * 500 + "\n")
    w = main.LaunchWatcher(str(log))
    w.poll()
    log.write_text(launch(7, 7))  # same file, shorter
    assert w.poll() == [(7, 7)]


def test_log_deleted(main, tmp_path):
    log = tmp_path / "console_log.txt"
    log.write_text("")
    w = main.LaunchWatcher(str(log))
    w.poll()
    os.remove(log)
    assert w.poll() == []
    log.write_text(launch(8, 1))
    assert w.poll() == [(8, 1)]


def test_watch_loop_emits_events(main, decky, tmp_path):
    log = tmp_path / "console_log.txt"
    log.write_text("")

    async def go():
        plugin = main.Plugin()
        task = asyncio.ensure_future(plugin._watch_launches(str(log), interval=0.01))
        await asyncio.sleep(0.05)
        append(log, launch(292030, 9))
        await asyncio.sleep(0.05)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(go())
    assert decky.emitted == [("launch_started", 292030, 9)]


def test_watch_loop_survives_errors(main, decky, tmp_path, monkeypatch):
    log = tmp_path / "console_log.txt"
    log.write_text("")
    calls = {"n": 0}
    real_poll = main.LaunchWatcher.poll

    def flaky(self):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("boom")
        return real_poll(self)

    monkeypatch.setattr(main.LaunchWatcher, "poll", flaky)
    real_sleep = asyncio.sleep
    monkeypatch.setattr(main.asyncio, "sleep", lambda s: real_sleep(min(s, 0.01)))

    async def go():
        plugin = main.Plugin()
        task = asyncio.ensure_future(plugin._watch_launches(str(log), interval=0.01))
        await real_sleep(0.1)
        append(log, launch(1, 1))
        await real_sleep(0.1)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(go())
    assert calls["n"] > 2
    assert ("launch_started", 1, 1) in decky.emitted
