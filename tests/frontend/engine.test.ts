import { describe, expect, it } from "vitest";
import {
  LAUNCH_DETECTION_TIMEOUT_MS,
  REMOTE_LAUNCH_TIMEOUT_MS,
  WRITE_ATTEMPTS,
  isValidRule,
  parseResolution,
} from "../../src/engine";
import { setup } from "./fakeHost";

const DECK = "steamdeck";
const PHONE = "iPhone";
const rules = { [DECK]: "1920x1200", [PHONE]: "1280x720" };

describe("parseResolution", () => {
  it.each([
    ["1920x1200", "1920x1200"],
    [" 1920 X 1200 ", "1920x1200"],
    ["1920*1200", "1920x1200"],
    ["1920×1200", "1920x1200"],
    ["320x200", "320x200"],
    ["7680x4320", "7680x4320"],
  ])("accepts %j", (input, expected) => expect(parseResolution(input)).toBe(expected));

  it.each(["", "abc", "1920x", "x1080", "100x100", "319x200", "7681x4320", "19200x1080", "1920x1080x2", "Native"])(
    "rejects %j",
    (input) => expect(parseResolution(input)).toBeNull(),
  );
});

describe("isValidRule", () => {
  it("allows Native and exact WIDTHxHEIGHT values only", () => {
    expect(isValidRule("Native")).toBe(true);
    expect(isValidRule("1920x1200")).toBe(true);
    expect(isValidRule("Default")).toBe(false);
    expect(isValidRule(" 1920x1200")).toBe(false);
    expect(isValidRule("1920X1200")).toBe(false);
  });
});

describe("streaming", () => {
  it("applies the device's rule when it connects and restores the old value when it disconnects", async () => {
    const { host, engine } = await setup({ config: { rules } });
    await engine.onStreamState(PHONE);
    expect(host.resolution).toBe("1280x720");
    expect(host.toasts).toEqual(["Gaugeshift | Maximum Resolution: 1280x720"]);
    expect(host.lastSaved?.session).toMatchObject({ device: PHONE, previous: "1920x1080", applied: "1280x720" });

    await engine.onStreamState("");
    expect(host.resolution).toBe("1920x1080");
    expect(host.writes).toEqual(["1280x720", "1920x1080"]);
    expect(host.lastSaved?.session).toBeNull();
  });

  it("saves what to restore before changing anything", async () => {
    const { host, engine } = await setup({ config: { rules } });
    await engine.onStreamState(PHONE);
    expect(host.events.indexOf("save session=1280x720")).toBeLessThan(host.events.indexOf("write 1280x720"));
  });

  it("restores the exact previous value, not just Default", async () => {
    const { host, engine } = await setup({ config: { rules }, resolution: "2560x1440" });
    await engine.onStreamState(DECK);
    await engine.onStreamState("");
    expect(host.resolution).toBe("2560x1440");
  });

  it("leaves the setting alone for a device without a rule, but remembers the device", async () => {
    const { host, engine } = await setup({ config: { rules: {} } });
    await engine.onStreamState(PHONE);
    await engine.onStreamState("");
    expect(host.writes).toEqual([]);
    expect(host.lastSaved?.devices[PHONE]).toBe(host.time);
  });

  it("does nothing when the setting already matches the rule", async () => {
    const { host, engine } = await setup({ config: { rules }, resolution: "1280x720" });
    await engine.onStreamState(PHONE);
    await engine.onStreamState("");
    expect(host.writes).toEqual([]);
    expect(host.resolution).toBe("1280x720");
  });

  it("handles a switch straight from one device to another", async () => {
    const { host, engine } = await setup({ config: { rules } });
    await engine.onStreamState(PHONE);
    await engine.onStreamState(DECK);
    expect(host.resolution).toBe("1920x1200");
    expect(host.lastSaved?.session).toMatchObject({ device: DECK, previous: "1920x1080" });
    await engine.onStreamState("");
    expect(host.resolution).toBe("1920x1080");
  });

  it("ignores repeated reports of the same stream", async () => {
    const { host, engine } = await setup({ config: { rules } });
    await engine.onStreamState(PHONE);
    await engine.onStreamState(PHONE);
    expect(host.writes).toEqual(["1280x720"]);
  });

  it("handles a burst of connects and disconnects in order", async () => {
    const { host, engine } = await setup({ config: { rules } });
    engine.onStreamState(PHONE);
    engine.onStreamState("");
    engine.onStreamState(DECK);
    engine.onStreamState("");
    await engine.idle();
    expect(host.writes).toEqual(["1280x720", "1920x1080", "1920x1200", "1920x1080"]);
    expect(host.resolution).toBe("1920x1080");
  });
});

describe("changes during a stream", () => {
  it("applies a new rule straight away and still restores the original value", async () => {
    const { host, engine } = await setup({ config: { rules } });
    await engine.onStreamState(PHONE);
    await engine.setRule(PHONE, "1920x1080");
    expect(host.lastSaved?.session).toMatchObject({ previous: "1920x1080", applied: "1920x1080" });
    await engine.setRule(PHONE, "2560x1440");
    expect(host.resolution).toBe("2560x1440");
    await engine.onStreamState("");
    expect(host.resolution).toBe("1920x1080");
  });

  it("restores straight away when the rule is set to Don't change", async () => {
    const { host, engine } = await setup({ config: { rules } });
    await engine.onStreamState(PHONE);
    await engine.setRule(PHONE, "");
    expect(host.resolution).toBe("1920x1080");
    expect(host.lastSaved?.session).toBeNull();
  });

  it("applies a rule for a device that is already streaming", async () => {
    const { host, engine } = await setup({ config: { rules: {} } });
    await engine.onStreamState(PHONE);
    await engine.setRule(PHONE, "1280x800");
    expect(host.resolution).toBe("1280x800");
  });

  it("doesn't apply a rule for a device that isn't streaming", async () => {
    const { host, engine } = await setup({ config: { rules: {} } });
    await engine.setRule(PHONE, "1280x800");
    expect(host.writes).toEqual([]);
  });

  it("restores when turned off, and applies again when turned back on", async () => {
    const { host, engine } = await setup({ config: { rules } });
    await engine.onStreamState(PHONE);
    await engine.setEnabled(false);
    expect(host.resolution).toBe("1920x1080");
    await engine.setEnabled(true);
    expect(host.resolution).toBe("1280x720");
  });

  it("does nothing while turned off", async () => {
    const { host, engine } = await setup({ config: { rules, enabled: false } });
    await engine.onStreamState(PHONE);
    expect(host.writes).toEqual([]);
  });

  it("respects a value set by hand during the stream", async () => {
    const { host, engine } = await setup({ config: { rules } });
    await engine.onStreamState(PHONE);
    host.resolution = "2560x1600"; // changed in Steam's settings
    await engine.onStreamState("");
    expect(host.resolution).toBe("2560x1600");
    expect(host.writes).toEqual(["1280x720"]);
    expect(host.lastSaved?.session).toBeNull();
  });

  it("treats a value set by hand as the new value to restore if the rule changes", async () => {
    const { host, engine } = await setup({ config: { rules } });
    await engine.onStreamState(PHONE);
    host.resolution = "2560x1600";
    await engine.setRule(PHONE, "1920x1080");
    await engine.onStreamState("");
    expect(host.resolution).toBe("2560x1600");
  });

  it("restores when the streaming device is forgotten", async () => {
    const { host, engine } = await setup({ config: { rules } });
    await engine.onStreamState(PHONE);
    await engine.forgetDevice(PHONE);
    expect(host.resolution).toBe("1920x1080");
    expect(host.lastSaved?.rules[PHONE]).toBeUndefined();
  });

  it("ignores invalid rules", async () => {
    const { host, engine } = await setup({ config: { rules: {} } });
    await engine.setRule(PHONE, "huge");
    await engine.setRule(PHONE, "Default");
    expect(engine.view().config.rules).toEqual({});
    expect(host.hasLog("warning", "invalid resolution")).toBe(true);
  });
});

describe("restarts and unloading", () => {
  const session = { device: PHONE, previous: "1920x1080", applied: "1280x720", started: 1 };

  it("restores a change left behind when it starts with nothing streaming", async () => {
    const { host } = await setup({ config: { rules, session }, resolution: "1280x720" });
    expect(host.resolution).toBe("1920x1080");
    expect(host.lastSaved?.session).toBeNull();
  });

  it("keeps the change when it starts while that stream is still running", async () => {
    const { host, engine } = await setup({ config: { rules, session }, streaming: PHONE, resolution: "1280x720" });
    expect(host.writes).toEqual([]);
    await engine.onStreamState("");
    expect(host.resolution).toBe("1920x1080");
  });

  it("applies the rule when it starts while a stream is already running", async () => {
    const { host } = await setup({ config: { rules }, streaming: DECK });
    expect(host.resolution).toBe("1920x1200");
  });

  it("doesn't undo a value set by hand while it wasn't running", async () => {
    const { host } = await setup({ config: { rules, session }, resolution: "3840x2160" });
    expect(host.writes).toEqual([]);
    expect(host.resolution).toBe("3840x2160");
    expect(host.lastSaved?.session).toBeNull();
  });

  it("restores when the plugin unloads mid-stream", async () => {
    const { host, engine } = await setup({ config: { rules } });
    await engine.onStreamState(PHONE);
    await engine.stop();
    expect(host.resolution).toBe("1920x1080");
  });

  it("changes nothing when it unloads with nothing to restore", async () => {
    const { host, engine } = await setup({ config: { rules } });
    await engine.stop();
    expect(host.writes).toEqual([]);
    expect(host.pendingTimers).toBe(0);
  });
});

describe("failures", () => {
  it("doesn't change anything if it can't read the current value", async () => {
    const { host, engine } = await setup({ config: { rules } });
    host.unreadable = true;
    await engine.onStreamState(PHONE);
    expect(host.writes).toEqual([]);
    expect(engine.view().warnings.map((w) => w.kind)).toEqual(["unreadable"]);

    host.unreadable = false;
    await engine.onStreamState("");
    await engine.onStreamState(PHONE);
    expect(host.resolution).toBe("1280x720");
    expect(engine.view().warnings).toEqual([]);
  });

  it("retries a change Steam doesn't confirm", async () => {
    const { host, engine } = await setup({ config: { rules } });
    host.failWrites = WRITE_ATTEMPTS - 1;
    await engine.onStreamState(PHONE);
    expect(host.writes).toHaveLength(WRITE_ATTEMPTS);
    expect(host.resolution).toBe("1280x720");
    expect(engine.view().warnings).toEqual([]);
  });

  it("gives up cleanly if the change never works", async () => {
    const { host, engine } = await setup({ config: { rules } });
    host.failWrites = WRITE_ATTEMPTS;
    await engine.onStreamState(PHONE);
    expect(host.resolution).toBe("1920x1080");
    expect(host.lastSaved?.session).toBeNull();
    expect(engine.view().warnings.map((w) => w.kind)).toEqual(["apply-failed"]);
    expect(host.toasts).toEqual(["Gaugeshift | Couldn't change to 1280x720"]);
    await engine.onStreamState("");
    expect(host.writes).toHaveLength(WRITE_ATTEMPTS); // nothing to restore
  });

  it("keeps trying to restore until it works", async () => {
    const { host, engine } = await setup({ config: { rules } });
    await engine.onStreamState(PHONE);
    host.failWrites = WRITE_ATTEMPTS;
    await engine.onStreamState("");
    expect(host.resolution).toBe("1280x720");
    expect(host.lastSaved?.session).not.toBeNull();
    expect(engine.view().warnings.map((w) => w.kind)).toEqual(["restore-failed"]);

    await engine.restoreNow();
    expect(host.resolution).toBe("1920x1080");
    expect(host.lastSaved?.session).toBeNull();
    expect(engine.view().warnings).toEqual([]);
  });

  it("keeps working if settings can't be saved", async () => {
    const { host, engine } = await setup({ config: { rules } });
    host.failSave = true;
    await engine.onStreamState(PHONE);
    await engine.onStreamState("");
    expect(host.writes).toEqual(["1280x720", "1920x1080"]);
    expect(host.hasLog("error", "Couldn't save settings")).toBe(true);
  });
});

describe("launches from another Steam device", () => {
  const online = (name: string) => ({ name, status: "Connected" });
  const offline = (name: string) => ({ name, status: "Paired" });

  it("applies the rule before the game starts, and keeps it when the stream connects", async () => {
    const { host, engine } = await setup({ config: { rules } });
    engine.onDevices([online(DECK), offline(PHONE)]);
    await engine.onLogLaunch(292030, 8);
    expect(host.resolution).toBe("1920x1200");
    expect(host.hasLog("info", "launched remotely (steamdeck)")).toBe(true);

    await engine.onStreamState(DECK);
    expect(host.writes).toEqual(["1920x1200"]);
    await engine.onStreamState("");
    expect(host.resolution).toBe("1920x1080");
  });

  it("ignores launches started from this machine's own UI", async () => {
    const { host, engine } = await setup({ config: { rules } });
    engine.onDevices([online(DECK)]);
    engine.onUiLaunch(292030, 8);
    await engine.onLogLaunch(292030, 8);
    expect(host.writes).toEqual([]);
    expect(host.hasLog("info", "launched from this machine's UI")).toBe(true);
  });

  it("ignores a UI launch that is reported just after the log line", async () => {
    const { host, engine } = await setup({ config: { rules } });
    engine.onDevices([online(DECK)]);
    const done = engine.onLogLaunch(292030, 8);
    engine.onUiLaunch(292030, 8);
    await done;
    expect(host.writes).toEqual([]);
  });

  it("undoes the change if no stream follows", async () => {
    const { host, engine } = await setup({ config: { rules } });
    engine.onDevices([online(DECK)]);
    await engine.onLogLaunch(292030, 8);
    host.advance(REMOTE_LAUNCH_TIMEOUT_MS - 1);
    await engine.idle();
    expect(host.resolution).toBe("1920x1200");
    host.advance(1);
    await engine.idle();
    expect(host.resolution).toBe("1920x1080");
    expect(host.hasLog("info", "didn't start a stream")).toBe(true);
  });

  it("doesn't undo once the stream has connected", async () => {
    const { host, engine } = await setup({ config: { rules } });
    engine.onDevices([online(DECK)]);
    await engine.onLogLaunch(292030, 8);
    await engine.onStreamState(DECK);
    host.advance(REMOTE_LAUNCH_TIMEOUT_MS * 2);
    await engine.idle();
    expect(host.resolution).toBe("1920x1200");
  });

  it("corrects a wrong guess when the stream connects", async () => {
    const { host, engine } = await setup({ config: { rules } });
    engine.onDevices([online(DECK)]);
    await engine.onLogLaunch(292030, 8);
    await engine.onStreamState(PHONE);
    expect(host.resolution).toBe("1280x720");
    await engine.onStreamState("");
    expect(host.resolution).toBe("1920x1080");
  });

  it("restores when the guess was wrong and the real device has no rule", async () => {
    const { host, engine } = await setup({ config: { rules: { [DECK]: "1920x1200" } } });
    engine.onDevices([online(DECK)]);
    await engine.onLogLaunch(292030, 8);
    await engine.onStreamState(PHONE);
    expect(host.resolution).toBe("1920x1080");
  });

  it("picks the most recently used device when several are online", async () => {
    const devices = { [DECK]: 100, [PHONE]: 200, Laptop: 50 };
    const { host, engine } = await setup({ config: { rules: { ...rules, Laptop: "2560x1600" }, devices } });
    engine.onDevices([online(DECK), online(PHONE), online("Laptop")]);
    await engine.onLogLaunch(292030, 8);
    expect(host.resolution).toBe("1280x720");
    expect(host.hasLog("info", "most recently used of 3")).toBe(true);
  });

  it("does nothing when no online device has a rule", async () => {
    const { host, engine } = await setup({ config: { rules } });
    engine.onDevices([offline(DECK), online("Laptop")]);
    await engine.onLogLaunch(292030, 8);
    expect(host.writes).toEqual([]);
  });

  it("ignores launches while something is already streaming", async () => {
    const { host, engine } = await setup({ config: { rules } });
    engine.onDevices([online(DECK)]);
    await engine.onStreamState(PHONE);
    await engine.onLogLaunch(292030, 8);
    expect(host.writes).toEqual(["1280x720"]);
  });

  it("does nothing while turned off", async () => {
    const { host, engine } = await setup({ config: { rules, enabled: false } });
    engine.onDevices([online(DECK)]);
    await engine.onLogLaunch(292030, 8);
    expect(host.writes).toEqual([]);
  });
});

describe("launch detection health check", () => {
  it("warns when the log watcher misses a launch the UI started", async () => {
    const { host, engine } = await setup({ config: { rules } });
    engine.onUiLaunch(292030, 8);
    host.advance(LAUNCH_DETECTION_TIMEOUT_MS);
    expect(engine.view().warnings.map((w) => w.kind)).toEqual(["launch-detection"]);

    await engine.onLogLaunch(400, 9);
    expect(engine.view().warnings).toEqual([]);
  });

  it("stays quiet when the log watcher reports the launch", async () => {
    const { host, engine } = await setup({ config: { rules } });
    engine.onUiLaunch(292030, 8);
    await engine.onLogLaunch(292030, 8);
    host.advance(LAUNCH_DETECTION_TIMEOUT_MS * 2);
    expect(engine.view().warnings).toEqual([]);
  });

  it("stays quiet when the log line arrives before the UI event", async () => {
    const { host, engine } = await setup({ config: { rules } });
    await engine.onLogLaunch(292030, 8);
    engine.onUiLaunch(292030, 8);
    host.advance(LAUNCH_DETECTION_TIMEOUT_MS * 2);
    expect(engine.view().warnings).toEqual([]);
  });

  it("cancels its checks when the plugin unloads", async () => {
    const { host, engine } = await setup({ config: { rules } });
    engine.onUiLaunch(292030, 8);
    await engine.stop();
    expect(host.pendingTimers).toBe(0);
  });
});

describe("view", () => {
  it("lists every known device once, sorted, with its rule and status", async () => {
    const { engine } = await setup({
      config: { rules: { [DECK]: "1920x1200" }, devices: { [PHONE]: 5, Old: 1 } },
    });
    engine.onDevices([
      { name: DECK, status: "Connected" },
      { name: "Tablet", status: "Paired" },
    ]);
    await engine.onStreamState(PHONE);
    expect(engine.view().devices.map((d) => [d.name, d.rule, d.online, d.streaming])).toEqual([
      ["iPhone", "", true, true],
      ["Old", "", false, false],
      ["steamdeck", "1920x1200", true, false],
      ["Tablet", "", false, false],
    ]);
  });

  it("notifies subscribers of changes", async () => {
    const { engine } = await setup({ config: { rules } });
    const seen: string[] = [];
    engine.subscribe((v) => seen.push(v.streamingTo));
    await engine.onStreamState(PHONE);
    expect(seen[0]).toBe("");
    expect(seen[seen.length - 1]).toBe(PHONE);
  });
});
