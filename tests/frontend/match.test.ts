// "Match screen" and the New devices default.

import { describe, expect, it } from "vitest";
import { MATCH, NONE, STEAM_DECK_SCREEN, defaultConfig, isValidRule, looksLikeSteamDeck } from "../../src/engine";
import { setup } from "./fakeHost";

const DECK = "steamdeck";
const PHONE = "iPhone";
const online = (name: string) => ({ name, status: "Connected" });

describe("defaults", () => {
  it("new devices match their screen out of the box", () => {
    expect(defaultConfig().newDevices).toBe(MATCH);
  });

  it("accepts Match and None as rules", () => {
    expect(isValidRule(MATCH)).toBe(true);
    expect(isValidRule(NONE)).toBe(true);
    expect(isValidRule("match")).toBe(false);
  });

  it.each([
    ["steamdeck", true],
    ["SteamDeck", true],
    ["steamdeck-2", true],
    ["Marks Deck", false],
    ["iPhone", false],
  ])("recognizes %j as a Steam Deck: %s", (name, expected) => {
    expect(looksLikeSteamDeck(name)).toBe(expected);
  });
});

describe("a brand-new Steam Deck", () => {
  it("gets 1280x800 straight away, without having to connect first", async () => {
    const { host, engine } = await setup({ config: { newDevices: MATCH } });
    await engine.onStreamState(DECK);
    expect(host.resolution).toBe(STEAM_DECK_SCREEN);
    expect(host.toasts).toEqual(["Gaugeshift | Maximum Resolution: 1280x800"]);
    await engine.onStreamState("");
    expect(host.resolution).toBe("1920x1080");
  });

  it("gets 1280x800 even when the Deck launches the game before its stream connects", async () => {
    const { host, engine } = await setup({ config: { newDevices: MATCH } });
    engine.onDevices([online(DECK)]);
    await engine.onLogLaunch(292030, 8);
    expect(host.resolution).toBe(STEAM_DECK_SCREEN);
  });

  it("switches to the screen size it actually reports", async () => {
    const { host, engine } = await setup({ config: { newDevices: MATCH } });
    await engine.onStreamState(DECK);
    await engine.onClientScreen(DECK, "1920x1200"); // e.g. a Deck with a higher-resolution screen
    expect(host.resolution).toBe("1920x1200");
    await engine.onStreamState("");
    expect(host.resolution).toBe("1920x1080");
  });

  it("makes no extra change when the reported size is the assumed one", async () => {
    const { host, engine } = await setup({ config: { newDevices: MATCH } });
    await engine.onStreamState(DECK);
    await engine.onClientScreen(DECK, STEAM_DECK_SCREEN);
    expect(host.writes).toEqual([STEAM_DECK_SCREEN]);
  });
});

describe("other new devices", () => {
  it("wait for the screen size, then use it", async () => {
    const { host, engine } = await setup({ config: { newDevices: MATCH } });
    await engine.onStreamState(PHONE);
    expect(host.writes).toEqual([]);
    expect(host.hasLog("info", "waiting for iPhone to report its screen size")).toBe(true);
    await engine.onClientScreen(PHONE, "2001x1125");
    expect(host.resolution).toBe("2001x1125");
    await engine.onStreamState("");
    expect(host.resolution).toBe("1920x1080");
  });

  it("use the remembered size straight away next time", async () => {
    const { host, engine } = await setup({ config: { newDevices: MATCH } });
    await engine.onStreamState(PHONE);
    await engine.onClientScreen(PHONE, "2001x1125");
    await engine.onStreamState("");
    await engine.onStreamState(PHONE);
    expect(host.resolution).toBe("2001x1125");
  });

  it("aren't guessed for a remote launch until their screen size is known", async () => {
    const { host, engine } = await setup({ config: { newDevices: MATCH } });
    engine.onDevices([online("Laptop")]);
    await engine.onLogLaunch(1, 1);
    expect(host.writes).toEqual([]);

    await engine.onStreamState("Laptop");
    await engine.onClientScreen("Laptop", "2560x1600");
    await engine.onStreamState("");
    await engine.onLogLaunch(2, 2);
    expect(host.resolution).toBe("2560x1600");
  });

  it("are left alone when New devices is set to Don't change", async () => {
    const { host, engine } = await setup({ config: { newDevices: NONE } });
    await engine.onStreamState(DECK);
    await engine.onClientScreen(DECK, "1280x800");
    expect(host.writes).toEqual([]);
    expect(engine.view().config.rules[DECK]).toBe(NONE);
  });
});

describe("the New devices setting", () => {
  it("is saved as each new device's own rule when it first connects", async () => {
    const { host, engine } = await setup({ config: { newDevices: MATCH } });
    await engine.onStreamState(PHONE);
    expect(host.lastSaved?.rules[PHONE]).toBe(MATCH);
    await engine.onStreamState("");

    // Changing the default later doesn't change devices that already have a rule.
    await engine.setNewDevices(NONE);
    await engine.onStreamState(PHONE);
    await engine.onClientScreen(PHONE, "2001x1125");
    expect(host.resolution).toBe("2001x1125");
  });

  it("decides whether an online Deck counts for remote launches", async () => {
    const { host, engine } = await setup({ config: { newDevices: NONE } });
    engine.onDevices([online(DECK)]);
    await engine.onLogLaunch(292030, 8); // Deck has no rule and the default is Don't change
    expect(host.writes).toEqual([]);
    await engine.setNewDevices(MATCH);
    await engine.onLogLaunch(292030, 9);
    expect(host.resolution).toBe(STEAM_DECK_SCREEN);
  });

  it("applies straight away to a streaming device that has no rule of its own", async () => {
    // Forgetting a device while it streams removes its rule, so the default applies to it.
    const { host, engine } = await setup({ config: { newDevices: NONE, rules: { [PHONE]: "1280x720" } } });
    await engine.onStreamState(PHONE);
    await engine.forgetDevice(PHONE);
    expect(host.resolution).toBe("1920x1080"); // default is Don't change: restored
    await engine.onClientScreen(PHONE, "2001x1125"); // learned again, but the default says leave it
    expect(host.resolution).toBe("1920x1080");
    await engine.setNewDevices(MATCH);
    expect(host.resolution).toBe("2001x1125");
  });

  it("ignores invalid values", async () => {
    const { engine } = await setup({ config: { newDevices: MATCH } });
    await engine.setNewDevices("1280x800" as never);
    expect(engine.view().config.newDevices).toBe(MATCH);
  });
});

describe("rules", () => {
  it("Match follows a device's reported screen", async () => {
    const { host, engine } = await setup({ config: { rules: { [PHONE]: MATCH }, screens: { [PHONE]: "2001x1125" } } });
    await engine.onStreamState(PHONE);
    expect(host.resolution).toBe("2001x1125");
  });

  it("None leaves the setting alone", async () => {
    const { host, engine } = await setup({ config: { rules: { [DECK]: NONE }, newDevices: MATCH } });
    await engine.onStreamState(DECK);
    expect(host.writes).toEqual([]);
  });

  it("an empty rule means None", async () => {
    const { engine } = await setup();
    await engine.setRule(PHONE, "");
    expect(engine.view().config.rules[PHONE]).toBe(NONE);
  });

  it("switching a streaming device to Match applies its screen size at once", async () => {
    const { host, engine } = await setup({ config: { rules: { [PHONE]: "1280x720" } } });
    await engine.onStreamState(PHONE);
    await engine.onClientScreen(PHONE, "2001x1125");
    expect(host.resolution).toBe("1280x720");
    await engine.setRule(PHONE, MATCH);
    expect(host.resolution).toBe("2001x1125");
  });

  it("a fixed rule isn't affected by screen reports", async () => {
    const { host, engine } = await setup({ config: { rules: { [DECK]: "1920x1200" } } });
    await engine.onStreamState(DECK);
    await engine.onClientScreen(DECK, "1280x800");
    expect(host.resolution).toBe("1920x1200");
    expect(engine.view().config.screens[DECK]).toBe("1280x800"); // still remembered
  });
});

describe("screen reports", () => {
  it("are remembered even when the device isn't streaming", async () => {
    const { host, engine } = await setup();
    await engine.onClientScreen(PHONE, "2001x1125");
    expect(host.lastSaved?.screens[PHONE]).toBe("2001x1125");
    expect(host.writes).toEqual([]);
  });

  it.each(["huge", "1x1", "Native", "1280X800"])("ignore the invalid size %j", async (size) => {
    const { host, engine } = await setup({ config: { rules: { [PHONE]: MATCH } } });
    await engine.onStreamState(PHONE);
    await engine.onClientScreen(PHONE, size);
    expect(host.writes).toEqual([]);
    expect(engine.view().config.screens[PHONE]).toBeUndefined();
  });

  it("don't save again when the size hasn't changed", async () => {
    const { host, engine } = await setup();
    await engine.onClientScreen(PHONE, "2001x1125");
    const saves = host.saved.length;
    await engine.onClientScreen(PHONE, "2001x1125");
    expect(host.saved.length).toBe(saves);
  });

  it("are forgotten with the device", async () => {
    const { engine } = await setup();
    await engine.onClientScreen(PHONE, "2001x1125");
    await engine.forgetDevice(PHONE);
    expect(engine.view().config.screens[PHONE]).toBeUndefined();
  });
});

describe("the panel", () => {
  it("shows each device's rule, whether it's the default, and its screen", async () => {
    const { engine } = await setup({
      config: { newDevices: MATCH, rules: { [PHONE]: "1280x720" }, screens: { [PHONE]: "2001x1125" } },
    });
    engine.onDevices([online(DECK), { name: "Tablet", status: "Paired" }]);
    const view = (name: string) => engine.view().devices.find((d) => d.name === name);
    expect(view(PHONE)).toMatchObject({ rule: "1280x720", ruleIsDefault: false, screen: "2001x1125" });
    expect(view(DECK)).toMatchObject({ rule: MATCH, ruleIsDefault: true, screen: "1280x800", screenAssumed: true });
    expect(view("Tablet")).toMatchObject({ rule: MATCH, ruleIsDefault: true, screenAssumed: false });
    expect(view("Tablet")?.screen).toBeUndefined();
  });
});
