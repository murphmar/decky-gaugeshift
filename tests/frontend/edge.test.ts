import { describe, expect, it } from "vitest";
import { WRITE_ATTEMPTS } from "../../src/engine";
import { setup } from "./fakeHost";

const DECK = "steamdeck";
const PHONE = "iPhone";

describe("edge cases", () => {
  it("logs an unexpected error and keeps handling later events", async () => {
    const { host, engine } = await setup({ config: { rules: { [PHONE]: "1280x720" } } });
    const real = host.readResolution.bind(host);
    host.readResolution = () => {
      throw new Error("Steam changed");
    };
    await engine.onStreamState(PHONE);
    expect(host.hasLog("error", "Steam changed")).toBe(true);

    host.readResolution = real;
    await engine.onStreamState("");
    await engine.onStreamState(PHONE);
    expect(host.resolution).toBe("1280x720");
  });

  it("hands the change over to the real device when its rule is the same as the guess", async () => {
    const same = "1920x1200";
    const { host, engine } = await setup({ config: { rules: { [DECK]: same, [PHONE]: same } } });
    engine.onDevices([{ name: DECK, status: "Connected" }]);
    await engine.onLogLaunch(292030, 8);
    await engine.onStreamState(PHONE);
    expect(host.writes).toEqual([same]);
    expect(host.lastSaved?.session?.device).toBe(PHONE);
  });

  it("keeps the earlier change if switching to a new rule mid-stream fails", async () => {
    const { host, engine } = await setup({ config: { rules: { [PHONE]: "1280x720" } } });
    await engine.onStreamState(PHONE);
    host.failWrites = WRITE_ATTEMPTS;
    await engine.setRule(PHONE, "1920x1080");
    expect(host.resolution).toBe("1280x720");
    expect(host.lastSaved?.session).toMatchObject({ previous: "1920x1080", applied: "1280x720" });

    await engine.onStreamState("");
    expect(host.resolution).toBe("1920x1080");
  });

  it("retries when changing the setting throws", async () => {
    const { host, engine } = await setup({ config: { rules: { [PHONE]: "1280x720" } } });
    let calls = 0;
    const real = host.writeResolution.bind(host);
    host.writeResolution = async (v: string) => {
      if (++calls === 1) throw new Error("not ready");
      return real(v);
    };
    await engine.onStreamState(PHONE);
    expect(host.resolution).toBe("1280x720");
    expect(host.hasLog("warning", "not ready")).toBe(true);
  });
});

describe("robustness", () => {
  it("keeps working if a panel listener throws", async () => {
    const { host, engine } = await setup({ config: { rules: { [PHONE]: "1280x720" } } });
    engine.subscribe(() => {
      throw new Error("render failed");
    });
    await engine.onStreamState(PHONE);
    await engine.onStreamState("");
    expect(host.writes).toEqual(["1280x720", "1920x1080"]);
    expect(host.hasLog("error", "render failed")).toBe(true);
  });
});
