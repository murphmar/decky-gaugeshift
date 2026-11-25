// Randomized stress tests. fast-check generates thousands of random
// sequences of events (devices connecting and disconnecting, launches from
// this machine and from other devices, rule changes, the user changing the
// setting by hand, Steam or the plugin restarting, Steam refusing changes)
// and checks after every step that Gaugeshift's promises still hold. When a
// sequence breaks a promise, fast-check shrinks it to the shortest one that
// still does, which makes failures easy to understand.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Engine,
  MATCH,
  NONE,
  REMOTE_LAUNCH_TIMEOUT_MS,
  STEAM_DECK_SCREEN,
  WRITE_ATTEMPTS,
  defaultConfig,
  isValidRule,
  looksLikeSteamDeck,
} from "../../src/engine";
import { FakeHost } from "./fakeHost";

const DEVICES = ["steamdeck", "iPhone", "Tablet"] as const;
const RULE_VALUES = ["1280x720", "1920x1200", "Native", MATCH, NONE] as const;
const SCREEN_SIZES = ["1280x800", "2001x1125"] as const;
// Values the user sets by hand never equal a rule value or a screen size, so
// the test can always tell the user's changes from Gaugeshift's.
const MANUAL_VALUES = ["Default", "1920x1080", "2560x1440"] as const;
const ORIGINAL = "Default";

type Command =
  | { kind: "connect"; device: string }
  | { kind: "disconnect" }
  | { kind: "localLaunch"; app: number }
  | { kind: "remoteLaunch"; app: number }
  | { kind: "setRule"; device: string; value: string }
  | { kind: "setEnabled"; enabled: boolean }
  | { kind: "manual"; value: string }
  | { kind: "wait"; ms: number }
  | { kind: "restart"; crash: boolean }
  | { kind: "forget"; device: string }
  | { kind: "restoreNow" }
  | { kind: "failWrites"; count: number }
  | { kind: "screen"; device: string; size: string }
  | { kind: "newDevices"; rule: typeof MATCH | typeof NONE };

const device = fc.constantFrom(...DEVICES);
const command = (withFailures: boolean): fc.Arbitrary<Command> => {
  const commands: fc.Arbitrary<Command>[] = [
    device.map((d) => ({ kind: "connect", device: d })),
    fc.constant({ kind: "disconnect" }),
    fc.integer({ min: 1, max: 5 }).map((app) => ({ kind: "localLaunch", app })),
    fc.integer({ min: 1, max: 5 }).map((app) => ({ kind: "remoteLaunch", app })),
    fc.record({ device, value: fc.constantFrom(...RULE_VALUES) }).map((r) => ({ kind: "setRule", ...r })),
    fc.boolean().map((enabled) => ({ kind: "setEnabled", enabled })),
    fc.constantFrom(...MANUAL_VALUES).map((value) => ({ kind: "manual", value })),
    fc.constantFrom(1_000, 30_000, REMOTE_LAUNCH_TIMEOUT_MS).map((ms) => ({ kind: "wait", ms })),
    fc.boolean().map((crash) => ({ kind: "restart", crash })),
    device.map((d) => ({ kind: "forget", device: d })),
    fc.constant({ kind: "restoreNow" }),
    fc.record({ device, size: fc.constantFrom(...SCREEN_SIZES) }).map((r) => ({ kind: "screen", ...r })),
    fc.constantFrom(MATCH, NONE).map((rule) => ({ kind: "newDevices", rule })),
  ];
  if (withFailures) {
    commands.push(fc.integer({ min: 1, max: WRITE_ATTEMPTS * 2 }).map((count) => ({ kind: "failWrites", count })));
  }
  return fc.oneof(...commands);
};

/** What the user expects, tracked independently of Gaugeshift's own state. */
interface Model {
  /** The value the setting should return to once nothing is streaming. */
  baseline: string;
  streaming: string;
  enabled: boolean;
  newDevices: typeof MATCH | typeof NONE;
  rules: Record<string, string>;
  screens: Record<string, string>;
  /** The user changed the setting during this stream; Gaugeshift must leave it. */
  touchedDuringStream: boolean;
}

class Harness {
  host = new FakeHost();
  engine!: Engine;
  model: Model = {
    baseline: ORIGINAL,
    streaming: "",
    enabled: true,
    newDevices: MATCH, // the product default
    rules: {},
    screens: {},
    touchedDuringStream: false,
  };
  appCounter = 100;

  async start() {
    this.host.resolution = ORIGINAL;
    await this.boot(defaultConfig());
  }

  private async boot(config: ReturnType<typeof defaultConfig>) {
    this.engine = new Engine(this.host, config);
    // The Steam Deck is online; the others are only paired.
    this.engine.onDevices([
      { name: "steamdeck", status: "Connected" },
      { name: "iPhone", status: "Paired" },
      { name: "Tablet", status: "Paired" },
    ]);
    await this.engine.onStreamState(this.model.streaming);
  }

  async run(c: Command) {
    const m = this.model;
    switch (c.kind) {
      case "connect":
        if (m.streaming && m.streaming !== c.device) m.touchedDuringStream = false;
        if (!m.streaming) m.touchedDuringStream = false;
        // Steam reporting the same stream again isn't a new connection.
        if (m.streaming !== c.device && m.rules[c.device] === undefined) m.rules[c.device] = m.newDevices;
        m.streaming = c.device;
        await this.engine.onStreamState(c.device);
        break;
      case "disconnect":
        m.streaming = "";
        m.touchedDuringStream = false;
        await this.engine.onStreamState("");
        break;
      case "localLaunch": {
        const action = this.appCounter++;
        this.engine.onUiLaunch(c.app, action);
        await this.engine.onLogLaunch(c.app, action);
        break;
      }
      case "remoteLaunch":
        await this.engine.onLogLaunch(c.app + 1000, this.appCounter++);
        break;
      case "setRule":
        m.rules[c.device] = c.value;
        await this.engine.setRule(c.device, c.value);
        break;
      case "screen":
        m.screens[c.device] = c.size;
        await this.engine.onClientScreen(c.device, c.size);
        break;
      case "newDevices":
        m.newDevices = c.rule;
        await this.engine.setNewDevices(c.rule);
        break;
      case "setEnabled":
        m.enabled = c.enabled;
        await this.engine.setEnabled(c.enabled);
        break;
      case "manual":
        // The user changes the setting in Steam's settings: that's the new
        // value to come back to.
        this.host.resolution = c.value;
        m.baseline = c.value;
        if (m.streaming) m.touchedDuringStream = true;
        break;
      case "wait":
        this.host.advance(c.ms);
        await this.engine.idle();
        break;
      case "restart": {
        // A clean unload restores first. A crash doesn't get the chance, and
        // takes everything the old frontend was running (timers too) with it.
        if (c.crash) this.host.clearAllTimers();
        else await this.engine.stop();
        const saved = this.host.lastSaved ?? defaultConfig();
        // On start-up a device that's already streaming counts as connecting,
        // so if it has no rule of its own it gets the New devices rule now.
        if (m.streaming && m.rules[m.streaming] === undefined) m.rules[m.streaming] = m.newDevices;
        await this.boot(saved);
        if (!c.crash && m.streaming) m.touchedDuringStream = false;
        break;
      }
      case "forget":
        delete m.rules[c.device];
        delete m.screens[c.device];
        await this.engine.forgetDevice(c.device);
        break;
      case "restoreNow":
        await this.engine.restoreNow();
        if (m.streaming) m.touchedDuringStream = true; // user chose to undo for this stream
        break;
      case "failWrites":
        this.host.failWrites = c.count;
        break;
    }
    await this.engine.idle();
  }

  /** Lets any pending remote-launch undo run, as time passing would. */
  async settle() {
    this.host.advance(REMOTE_LAUNCH_TIMEOUT_MS + 1);
    await this.engine.idle();
  }

  checkAlways() {
    expect(this.host.hasLog("error", "Unexpected error")).toBe(false);
    for (const w of this.host.writes) {
      expect(w !== MATCH && w !== NONE).toBe(true); // rules are resolved before they're written
      expect(isValidRule(w) || MANUAL_VALUES.includes(w as never)).toBe(true);
    }
  }

  /** While a device streams, the setting follows its rule. */
  checkStreaming() {
    const m = this.model;
    if (!m.streaming || m.touchedDuringStream) return;
    if (!m.enabled) return expect(this.host.resolution).toBe(m.baseline);
    const rule = m.rules[m.streaming] ?? m.newDevices;
    if (rule === NONE) return expect(this.host.resolution).toBe(m.baseline);
    if (rule !== MATCH) return expect(this.host.resolution).toBe(rule);
    const screen = m.screens[m.streaming] ?? (looksLikeSteamDeck(m.streaming) ? STEAM_DECK_SCREEN : undefined);
    // Without a screen size yet, Gaugeshift waits; nothing to check until it arrives.
    if (screen) expect(this.host.resolution).toBe(screen);
  }

  /** With nothing streaming, the setting is back where the user left it. */
  async checkIdle() {
    if (this.model.streaming) return;
    await this.settle();
    expect(this.host.resolution).toBe(this.model.baseline);
    expect(this.engine.view().config.session).toBeNull();
  }
}

describe("random sequences of events", () => {
  it("always ends up back at the user's own setting, and follows the rules while streaming", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command(false), { minLength: 1, maxLength: 40 }), async (commands) => {
        const h = new Harness();
        await h.start();
        for (const c of commands) {
          await h.run(c);
          h.checkAlways();
          if (c.kind !== "remoteLaunch") h.checkStreaming();
          if (c.kind === "disconnect") await h.checkIdle();
        }
        await h.run({ kind: "disconnect" });
        await h.checkIdle();
      }),
      { numRuns: Number(process.env.STRESS_RUNS ?? 2000) },
    );
  });

  it("recovers once Steam starts accepting changes again", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command(true), { minLength: 1, maxLength: 40 }), async (commands) => {
        const h = new Harness();
        await h.start();
        for (const c of commands) {
          await h.run(c);
          h.checkAlways();
        }
        // Steam works again, the stream ends, and the user presses Restore
        // if Gaugeshift showed it couldn't put the setting back.
        h.host.failWrites = 0;
        await h.run({ kind: "disconnect" });
        await h.settle();
        await h.run({ kind: "restoreNow" });
        expect(h.host.resolution).toBe(h.model.baseline);
        expect(h.engine.view().config.session).toBeNull();
      }),
      { numRuns: Number(process.env.STRESS_RUNS ?? 2000) },
    );
  });
});
