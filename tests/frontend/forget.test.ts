// Forgetting a device from the panel.

import { describe, expect, it } from "vitest";
import { MATCH, STEAM_DECK_SCREEN } from "../../src/engine";
import { setup } from "./fakeHost";

const PHONE = "iPhone";
const DECK = "steamdeck";
const names = (engine: Awaited<ReturnType<typeof setup>>["engine"]) => engine.view().devices.map((d) => d.name);

describe("forgetting a device", () => {
  it("removes a device Steam doesn't list from the panel, with its rule, screen and history", async () => {
    const { host, engine } = await setup({ config: { rules: { Laptop: "2560x1600" } } });
    await engine.onStreamState("Laptop");
    await engine.onClientScreen("Laptop", "2560x1600");
    await engine.onStreamState("");
    expect(names(engine)).toContain("Laptop");

    await engine.forgetDevice("Laptop");
    expect(names(engine)).not.toContain("Laptop");
    const saved = host.lastSaved!;
    expect(saved.rules.Laptop).toBeUndefined();
    expect(saved.screens.Laptop).toBeUndefined();
    expect(saved.devices.Laptop).toBeUndefined();
  });

  it("keeps a device Steam lists as paired, back on the New devices setting", async () => {
    const { engine } = await setup({
      config: { newDevices: MATCH, rules: { [PHONE]: "1280x720" }, screens: { [PHONE]: "2001x1125" } },
    });
    engine.onDevices([{ name: PHONE, status: "Paired" }]);
    expect(engine.view().devices.find((d) => d.name === PHONE)).toMatchObject({ paired: true, rule: "1280x720" });

    await engine.forgetDevice(PHONE);
    const phone = engine.view().devices.find((d) => d.name === PHONE);
    expect(phone).toMatchObject({ paired: true, rule: MATCH, ruleIsDefault: true, screenAssumed: false });
    expect(phone?.screen).toBeUndefined();
  });

  it("treats a forgotten device as new when it streams again", async () => {
    const { host, engine } = await setup({
      config: { newDevices: MATCH, rules: { [PHONE]: "1280x720" }, screens: { [PHONE]: "2001x1125" } },
    });
    await engine.forgetDevice(PHONE);
    await engine.onStreamState(PHONE);
    expect(host.lastSaved?.rules[PHONE]).toBe(MATCH);
    expect(host.writes).toEqual([]); // waits for its screen size again
    await engine.onClientScreen(PHONE, "2001x1125");
    expect(host.resolution).toBe("2001x1125");
  });

  it("still covers a forgotten Steam Deck from its next first launch", async () => {
    const { host, engine } = await setup({ config: { newDevices: MATCH, rules: { [DECK]: "1920x1200" } } });
    await engine.forgetDevice(DECK);
    engine.onDevices([{ name: DECK, status: "Connected" }]);
    await engine.onLogLaunch(292030, 8);
    expect(host.resolution).toBe(STEAM_DECK_SCREEN);
  });

  it("does nothing for a device it never knew", async () => {
    const { host, engine } = await setup();
    await engine.forgetDevice("Nobody");
    expect(host.writes).toEqual([]);
    expect(names(engine)).toEqual([]);
  });
});
