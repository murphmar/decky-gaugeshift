import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeStringSetting,
  getGameResolution,
  onDevicesChanged,
  onStreamStateChanged,
  onUiLaunchStarted,
  setGameResolutionVerified,
} from "../../src/steam";

const decode = (b64: string) => [...Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))];
const g = globalThis as Record<string, unknown>;

/** A pretend Steam client with just the parts Gaugeshift uses. */
function fakeSteam() {
  const callbacks: Record<string, (...args: unknown[]) => void> = {};
  const unregister = vi.fn();
  const register = (name: string) => (cb: (...args: unknown[]) => void) => {
    callbacks[name] = cb;
    return { unregister };
  };
  const store = { m_ClientSettings: { gamescope_game_resolution_global: "Default" as unknown } };
  const SetSetting = vi.fn(async (b64: string) => {
    // Steam applies the change a moment later.
    const bytes = decode(b64);
    const text = new TextDecoder().decode(Uint8Array.from(bytes.slice(4)));
    setTimeout(() => (store.m_ClientSettings.gamescope_game_resolution_global = text), 50);
  });
  g.settingsStore = store;
  g.SteamClient = {
    Settings: { SetSetting },
    RemotePlay: {
      RegisterForSettingsChanges: register("rp"),
      RegisterForDevicesChanges: register("devices"),
    },
    Apps: { RegisterForGameActionStart: register("gameAction") },
  };
  return { callbacks, unregister, store, SetSetting };
}

afterEach(() => {
  delete g.SteamClient;
  delete g.settingsStore;
  vi.useRealTimers();
});

describe("encodeStringSetting", () => {
  it("encodes Maximum Game Resolution the way Steam expects", () => {
    // Field 21012, wire type 2 -> tag bytes a2 a1 0a, then length, then the text.
    expect(encodeStringSetting(21012, "Default")).toBe("oqEKB0RlZmF1bHQ="); // captured from a working setup
    expect(decode(encodeStringSetting(21012, "1920x1200"))).toEqual([
      0xa2,
      0xa1,
      0x0a,
      9,
      ...[..."1920x1200"].map((c) => c.charCodeAt(0)),
    ]);
  });

  it("handles long values with a multi-byte length", () => {
    const bytes = decode(encodeStringSetting(21012, "x".repeat(200)));
    expect(bytes.slice(0, 5)).toEqual([0xa2, 0xa1, 0x0a, 0xc8, 0x01]);
    expect(bytes.length).toBe(5 + 200);
  });
});

describe("getGameResolution", () => {
  it("reads Steam's current value", () => {
    const { store } = fakeSteam();
    store.m_ClientSettings.gamescope_game_resolution_global = "1920x1080";
    expect(getGameResolution()).toBe("1920x1080");
  });

  it.each([undefined, "", 42, null])("returns undefined for %j", (value) => {
    const { store } = fakeSteam();
    store.m_ClientSettings.gamescope_game_resolution_global = value;
    expect(getGameResolution()).toBeUndefined();
  });

  it("returns undefined instead of throwing if Steam's settings store is missing", () => {
    expect(getGameResolution()).toBeUndefined();
    g.settingsStore = {};
    expect(getGameResolution()).toBeUndefined();
  });
});

describe("setGameResolutionVerified", () => {
  beforeEach(() => vi.useFakeTimers());

  it("sends the encoded setting and waits for Steam to confirm it", async () => {
    const { SetSetting } = fakeSteam();
    const result = setGameResolutionVerified("1920x1200");
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe(true);
    expect(SetSetting).toHaveBeenCalledWith(encodeStringSetting(21012, "1920x1200"));
  });

  it("reports failure if Steam never shows the new value", async () => {
    const { SetSetting } = fakeSteam();
    SetSetting.mockImplementation(async () => {});
    const result = setGameResolutionVerified("1920x1200");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBe(false);
  });
});

describe("onStreamStateChanged", () => {
  it("reports the streaming client's name and session", () => {
    const { callbacks } = fakeSteam();
    const seen: unknown[] = [];
    onStreamStateChanged((s) => seen.push(s));
    callbacks.rp({ strStreamingClientName: "iPhone", unStreamingSessionID: 3 });
    callbacks.rp({ strStreamingClientName: "", unStreamingSessionID: 0 });
    expect(seen).toEqual([
      { clientName: "iPhone", sessionId: 3 },
      { clientName: "", sessionId: 0 },
    ]);
  });

  it("treats missing or odd fields as not streaming", () => {
    const { callbacks } = fakeSteam();
    const seen: unknown[] = [];
    onStreamStateChanged((s) => seen.push(s));
    callbacks.rp(undefined);
    callbacks.rp({ strStreamingClientName: 7, unStreamingSessionID: "x" });
    expect(seen).toEqual([
      { clientName: "", sessionId: 0 },
      { clientName: "", sessionId: 0 },
    ]);
  });

  it("unregisters, even if Steam throws while doing so", () => {
    const { unregister } = fakeSteam();
    const stop = onStreamStateChanged(() => {});
    unregister.mockImplementation(() => {
      throw new Error("gone");
    });
    expect(() => stop()).not.toThrow();
    expect(unregister).toHaveBeenCalled();
  });
});

describe("onDevicesChanged", () => {
  it("reports each device's name and status, skipping nameless ones", () => {
    const { callbacks } = fakeSteam();
    const seen: unknown[] = [];
    onDevicesChanged((d) => seen.push(d));
    callbacks.devices([{ clientName: "steamdeck", status: "Connected" }, { clientName: "" }, { status: "Paired" }]);
    callbacks.devices(null);
    expect(seen).toEqual([[{ name: "steamdeck", status: "Connected" }], []]);
  });
});

describe("onUiLaunchStarted", () => {
  it("passes on the app ID and action ID (Steam sends them the other way round)", () => {
    const { callbacks } = fakeSteam();
    const seen: unknown[] = [];
    onUiLaunchStarted((appId, actionId) => seen.push([appId, actionId]));
    callbacks.gameAction(8, "292030", "LaunchApp");
    expect(seen).toEqual([[292030, 8]]);
  });
});

describe("unregistering", () => {
  it("unregisters device and launch listeners", () => {
    const { unregister } = fakeSteam();
    onDevicesChanged(() => {})();
    onUiLaunchStarted(() => {})();
    expect(unregister).toHaveBeenCalledTimes(2);
  });
});
