// Randomized stress tests. fast-check generates thousands of random
// sequences of events (devices connecting and disconnecting, launches from
// this machine and from other devices, rule changes, the user changing the
// setting by hand, Steam or the plugin restarting, Steam refusing changes)
// and checks after every step that Gaugeshift's promises still hold. When a
// sequence breaks a promise, fast-check shrinks it to the shortest one that
// still does, which makes failures easy to understand.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Engine, REMOTE_LAUNCH_TIMEOUT_MS, WRITE_ATTEMPTS, defaultConfig, isValidRule } from "../../src/engine";
import { FakeHost } from "./fakeHost";

const DEVICES = ["steamdeck", "iPhone", "Tablet"] as const;
const RULE_VALUES = ["1280x720", "1920x1200", "Native", ""] as const; // "" = Don't change
// Values the user sets by hand never equal a rule value, so the test can
// always tell the user's changes from Gaugeshift's.
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
  | { kind: "failWrites"; count: number };

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
  rules: Record<string, string>;
  /** The user changed the setting during this stream; Gaugeshift must leave it. */
  touchedDuringStream: boolean;
}

class Harness {
  host = new FakeHost();
  engine!: Engine;
  model: Model = { baseline: ORIGINAL, streaming: "", enabled: true, rules: {}, touchedDuringStream: false };
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
        if (c.value) m.rules[c.device] = c.value;
        else delete m.rules[c.device];
        await this.engine.setRule(c.device, c.value);
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
        // A clean unload restores first; a crash doesn't get the chance.
        if (!c.crash) await this.engine.stop();
        const saved = this.host.lastSaved ?? defaultConfig();
        await this.boot(saved);
        if (!c.crash && m.streaming) m.touchedDuringStream = false;
        break;
      }
      case "forget":
        delete m.rules[c.device];
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
    for (const w of this.host.writes) expect(isValidRule(w) || MANUAL_VALUES.includes(w as never)).toBe(true);
  }

  /** While a device streams, the setting follows its rule. */
  checkStreaming() {
    const m = this.model;
    if (!m.streaming || m.touchedDuringStream) return;
    const rule = m.enabled ? m.rules[m.streaming] : undefined;
    expect(this.host.resolution).toBe(rule ?? m.baseline);
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
      { numRuns: 2000 },
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
      { numRuns: 2000 },
    );
  });
});
