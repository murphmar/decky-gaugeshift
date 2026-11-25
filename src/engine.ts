// Gaugeshift's decision-making, kept free of any Steam or Decky APIs so it
// can be tested in isolation. Everything it needs from the outside world
// comes through the `Host` interface; everything that happens to it arrives
// through the `on…` methods.

export const CONFIG_VERSION = 2;

/** A change Gaugeshift made and must undo when the stream ends. */
export interface Session {
  /** Device the change was made for. */
  device: string;
  /** Value to put back when the stream ends. */
  previous: string;
  /** Value Gaugeshift set. */
  applied: string;
  /** When the change was made (ms since epoch). */
  started: number;
}

/**
 * A device's rule:
 * - "Match": the device's own screen size (learned from its first stream);
 * - "None": don't change anything;
 * - "Native": Steam's "Native" option;
 * - "WIDTHxHEIGHT": that resolution.
 */
export type Rule = string;
export const MATCH = "Match";
export const NONE = "None";

/** What a device without a rule of its own gets. */
export type NewDevicesRule = typeof MATCH | typeof NONE;

export interface Config {
  version: number;
  enabled: boolean;
  newDevices: NewDevicesRule;
  /** Device name -> its rule. Devices without one use `newDevices`. */
  rules: Record<string, Rule>;
  /** Device name -> when it last streamed from this machine (ms since epoch). */
  devices: Record<string, number>;
  /** Device name -> the screen size it reported ("1280x800"). */
  screens: Record<string, string>;
  /** Present only while Gaugeshift has the setting changed. */
  session: Session | null;
}

/** Screen size assumed for a Steam Deck until it reports its own. */
export const STEAM_DECK_SCREEN = "1280x800";

/** SteamOS names a Steam Deck "steamdeck" unless its owner renames it. */
export function looksLikeSteamDeck(name: string): boolean {
  return /^steamdeck/i.test(name);
}

export interface RemoteDevice {
  name: string;
  /** Steam's status, e.g. "Paired" (offline), "Connected" (online), "Streaming". */
  status: string;
}

export type LogLevel = "info" | "warning" | "error";

export interface Host {
  /** Current Maximum Game Resolution, or undefined if it can't be read. */
  readResolution(): string | undefined;
  /** Sets Maximum Game Resolution; resolves true once Steam reports the new value. */
  writeResolution(value: string): Promise<boolean>;
  saveConfig(config: Config): Promise<void>;
  log(level: LogLevel, message: string): void;
  /** Shows a notification. Keep both short: Steam cuts off long text. */
  toast(title: string, body: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export type WarningKind =
  | "unreadable" // can't read the current setting
  | "apply-failed" // couldn't change the setting
  | "restore-failed" // couldn't put the setting back
  | "launch-detection"; // remote-launch detection doesn't seem to work

export interface DeviceView {
  name: string;
  /** The device's rule (its own, or the New devices default). */
  rule: Rule;
  /** Whether `rule` is the New devices default rather than the device's own. */
  ruleIsDefault: boolean;
  /** Screen size the device reported, or the one assumed for a Steam Deck. */
  screen?: string;
  /** `screen` is assumed (Steam Deck), not reported. */
  screenAssumed: boolean;
  online: boolean;
  streaming: boolean;
  /** Last time it streamed from this machine (ms since epoch), if ever. */
  lastSeen?: number;
}

export interface ViewState {
  config: Config;
  streamingTo: string;
  current: string | undefined;
  devices: DeviceView[];
  warnings: { kind: WarningKind; message: string }[];
}

/** Wait after a launch starts, so Steam's UI can report launches it started itself. */
export const UI_LAUNCH_GRACE_MS = 400;
/** Undo a remote-launch change if no stream follows within this time. */
export const REMOTE_LAUNCH_TIMEOUT_MS = 60_000;
/** A UI launch the log watcher hasn't reported by now means detection is broken. */
export const LAUNCH_DETECTION_TIMEOUT_MS = 15_000;
/** How many times to try changing the setting before giving up. */
export const WRITE_ATTEMPTS = 3;

export function defaultConfig(): Config {
  return {
    version: CONFIG_VERSION,
    enabled: true,
    newDevices: MATCH,
    rules: {},
    devices: {},
    screens: {},
    session: null,
  };
}

/** "1920x1200", " 1920 X 1200 ", "1920*1200" -> "1920x1200"; null if invalid. */
export function parseResolution(text: string): string | null {
  const m = text
    .trim()
    .toLowerCase()
    .match(/^(\d{3,5})\s*[x×*]\s*(\d{3,5})$/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w < 320 || h < 200 || w > 7680 || h > 4320) return null;
  return `${w}x${h}`;
}

/** A valid rule: "Match", "None", "Native" or an exact WIDTHxHEIGHT. */
export function isValidRule(value: string): boolean {
  return value === MATCH || value === NONE || value === "Native" || parseResolution(value) === value;
}

const isOnline = (d: RemoteDevice) => d.status !== "" && d.status !== "Paired";

export class Engine {
  private config: Config;
  private streamingTo = "";
  private devices: RemoteDevice[] = [];
  private firstStreamEvent = true;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<(v: ViewState) => void>();
  private warnings = new Map<WarningKind, string>();
  /** Launches seen recently: "ui:action:7", "ui:app:292030", "log:app:292030" -> time. */
  private recentLaunches = new Map<string, number>();
  private remoteLaunchTimer: unknown;
  private detectionTimers = new Map<number, unknown>();

  constructor(
    private host: Host,
    config: Config,
  ) {
    this.config = structuredClone(config);
  }

  // ---------------------------------------------------------------- inputs

  /** Steam reported the streaming state: the client's name, or "" when idle. */
  onStreamState(clientName: string): Promise<void> {
    return this.enqueue(() => this.handleStreamState(clientName));
  }

  /** Steam reported the devices it knows for Remote Play / Steam Link. */
  onDevices(devices: RemoteDevice[]): void {
    this.devices = devices.filter((d) => d.name);
    this.emit();
  }

  /** Steam's own UI started a launch (on this machine's screen or over Steam Link). */
  onUiLaunch(appId: number, actionId: number): void {
    const now = this.host.now();
    this.recentLaunches.set(`ui:action:${actionId}`, now);
    this.recentLaunches.set(`ui:app:${appId}`, now);
    // The log watcher should report every launch. If it misses one the UI
    // definitely started, remote-launch detection is probably broken.
    if (this.seenRecently(`log:app:${appId}`, LAUNCH_DETECTION_TIMEOUT_MS)) return;
    const old = this.detectionTimers.get(appId);
    if (old !== undefined) this.host.clearTimer(old);
    this.detectionTimers.set(
      appId,
      this.host.setTimer(() => {
        this.detectionTimers.delete(appId);
        this.host.log("warning", `Launch of app ${appId} wasn't seen in Steam's log`);
        this.warn(
          "launch-detection",
          "Launches from other devices (like a Steam Deck) can't be detected with this Steam version, so they may start before the resolution changes.",
        );
      }, LAUNCH_DETECTION_TIMEOUT_MS),
    );
  }

  /** The backend saw a launch start in Steam's log (any launch, local or remote). */
  onLogLaunch(appId: number, actionId: number): Promise<void> {
    this.recentLaunches.set(`log:app:${appId}`, this.host.now());
    const timer = this.detectionTimers.get(appId);
    if (timer !== undefined) {
      this.host.clearTimer(timer);
      this.detectionTimers.delete(appId);
    }
    this.clearWarning("launch-detection");
    return this.enqueue(() => this.handleLogLaunch(appId, actionId));
  }

  // --------------------------------------------------------- user actions

  setEnabled(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.config.enabled = enabled;
      await this.save();
      if (!enabled) await this.restore("turned off");
      else if (this.streamingTo) await this.applyRule(this.streamingTo, "turned on");
    });
  }

  /** Sets a device's rule ("Match", "None", "Native" or WIDTHxHEIGHT; "" also means "None"). */
  setRule(device: string, rule: Rule): Promise<void> {
    return this.enqueue(async () => {
      const value = rule || NONE;
      if (!isValidRule(value)) {
        this.host.log("warning", `Ignoring invalid resolution ${JSON.stringify(rule)}`);
        return;
      }
      this.config.rules[device] = value;
      await this.save();
      this.host.log("info", `Rule for ${device}: ${value}`);
      if (device === this.streamingTo) await this.applyRule(device, "rule changed");
    });
  }

  /** Sets what devices without a rule of their own get. */
  setNewDevices(rule: NewDevicesRule): Promise<void> {
    return this.enqueue(async () => {
      if (rule !== MATCH && rule !== NONE) return;
      this.config.newDevices = rule;
      await this.save();
      this.host.log("info", `New devices: ${rule}`);
      if (this.streamingTo && this.config.rules[this.streamingTo] === undefined) {
        await this.applyRule(this.streamingTo, "New devices setting changed");
      }
    });
  }

  /** A device reported its screen size (it does a moment after its stream starts). */
  onClientScreen(device: string, size: string): Promise<void> {
    return this.enqueue(async () => {
      if (parseResolution(size) !== size) {
        this.host.log("warning", `Ignoring odd screen size ${JSON.stringify(size)} from ${device}`);
        return;
      }
      if (this.config.screens[device] !== size) {
        this.config.screens[device] = size;
        await this.save();
        this.host.log("info", `${device} has a ${size} screen`);
      }
      if (device === this.streamingTo) await this.applyRule(device, `${device} reported its screen`);
    });
  }

  forgetDevice(device: string): Promise<void> {
    return this.enqueue(async () => {
      delete this.config.rules[device];
      delete this.config.devices[device];
      delete this.config.screens[device];
      await this.save();
      if (device === this.streamingTo) await this.applyRule(device, "device forgotten");
    });
  }

  restoreNow(): Promise<void> {
    return this.enqueue(() => this.restore("restored manually"));
  }

  /** The plugin is unloading: never leave the setting changed behind us. */
  stop(): Promise<void> {
    this.clearRemoteLaunchTimer();
    for (const t of this.detectionTimers.values()) this.host.clearTimer(t);
    this.detectionTimers.clear();
    return this.enqueue(() => this.restore("plugin unloading"));
  }

  // ------------------------------------------------------------- outputs

  subscribe(listener: (v: ViewState) => void): () => void {
    this.listeners.add(listener);
    try {
      listener(this.view());
    } catch (e) {
      this.host.log("error", `Panel update failed: ${e}`);
    }
    return () => this.listeners.delete(listener);
  }

  view(): ViewState {
    return {
      config: structuredClone(this.config),
      streamingTo: this.streamingTo,
      current: this.readCurrent(),
      devices: this.deviceViews(),
      warnings: [...this.warnings].map(([kind, message]) => ({ kind, message })),
    };
  }

  /** Resolves once every queued action has finished. */
  idle(): Promise<void> {
    return this.queue;
  }

  // ------------------------------------------------------------ internals

  private deviceViews(): DeviceView[] {
    const names = new Set<string>([
      ...Object.keys(this.config.devices),
      ...Object.keys(this.config.rules),
      ...this.devices.map((d) => d.name),
    ]);
    if (this.streamingTo) names.add(this.streamingTo);
    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const steam = this.devices.find((d) => d.name === name);
        const reported = this.config.screens[name];
        const assumed = !reported && looksLikeSteamDeck(name);
        return {
          name,
          rule: this.ruleFor(name),
          ruleIsDefault: this.config.rules[name] === undefined,
          screen: reported ?? (assumed ? STEAM_DECK_SCREEN : undefined),
          screenAssumed: assumed,
          online: name === this.streamingTo || (steam ? isOnline(steam) : false),
          streaming: name === this.streamingTo,
          lastSeen: this.config.devices[name],
        };
      });
  }

  private emit() {
    let v: ViewState;
    try {
      v = this.view();
    } catch (e) {
      this.host.log("error", `Couldn't build the panel state: ${e}`);
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(v);
      } catch (e) {
        this.host.log("error", `Panel update failed: ${e}`);
      }
    }
  }

  private readCurrent(): string | undefined {
    try {
      return this.host.readResolution();
    } catch (e) {
      this.host.log("error", `Couldn't read Maximum Game Resolution: ${e}`);
      return undefined;
    }
  }

  private warn(kind: WarningKind, message: string) {
    if (this.warnings.get(kind) === message) return;
    this.warnings.set(kind, message);
    this.emit();
  }

  private clearWarning(kind: WarningKind) {
    if (this.warnings.delete(kind)) this.emit();
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    // Handle events one at a time, in order, so a quick connect/disconnect
    // can never interleave.
    // Nothing may reject this chain, or every later event would be skipped.
    this.queue = this.queue
      .then(fn)
      .catch((e) => {
        this.host.log("error", `Unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
      })
      .then(() => this.emit());
    return this.queue;
  }

  private async save() {
    try {
      await this.host.saveConfig(structuredClone(this.config));
    } catch (e) {
      this.host.log("error", `Couldn't save settings: ${e}`);
    }
  }

  private seenRecently(key: string, withinMs: number): boolean {
    const t = this.recentLaunches.get(key);
    return t !== undefined && this.host.now() - t <= withinMs;
  }

  private pruneLaunches() {
    const now = this.host.now();
    for (const [key, t] of this.recentLaunches) if (now - t > 60_000) this.recentLaunches.delete(key);
  }

  private clearRemoteLaunchTimer() {
    if (this.remoteLaunchTimer !== undefined) this.host.clearTimer(this.remoteLaunchTimer);
    this.remoteLaunchTimer = undefined;
  }

  private async handleStreamState(clientName: string) {
    const first = this.firstStreamEvent;
    this.firstStreamEvent = false;
    const previous = this.streamingTo;
    this.streamingTo = clientName;
    if (clientName) this.clearRemoteLaunchTimer();

    if (first) {
      // Steam reports the current state as soon as we subscribe. Use it to
      // recover from a restart: undo a change left behind, or (re)apply the
      // rule for a stream that's already running.
      if (!clientName) {
        if (this.config.session) await this.restore("recovering after a restart");
      } else {
        await this.onConnected(clientName);
      }
      return;
    }

    if (clientName === previous) return;
    if (previous) await this.restore(`${previous} disconnected`);
    if (clientName) await this.onConnected(clientName);
  }

  private ruleFor(device: string): Rule {
    return this.config.rules[device] ?? this.config.newDevices;
  }

  /**
   * The resolution to use for `device`, if any. `waiting` means its rule is
   * "Match" but its screen size isn't known yet.
   */
  private targetFor(device: string): { target?: string; waiting?: boolean } {
    if (!this.config.enabled) return {};
    const rule = this.ruleFor(device);
    if (rule === NONE) return {};
    if (rule !== MATCH) return { target: rule };
    const screen = this.config.screens[device] ?? (looksLikeSteamDeck(device) ? STEAM_DECK_SCREEN : undefined);
    return screen ? { target: screen } : { waiting: true };
  }

  private async onConnected(device: string) {
    this.config.devices[device] = this.host.now();
    // A new device gets the New devices rule as its own, so the panel shows
    // it and later changes to the default don't affect it.
    if (this.config.rules[device] === undefined) this.config.rules[device] = this.config.newDevices;
    await this.save();
    await this.applyRule(device, `${device} connected`);
  }

  /**
   * A launch started. If Steam's UI didn't start it and nothing is streaming
   * yet, a remote Steam client (such as a Steam Deck choosing "Stream") asked
   * for it. Its stream only connects once the game is already starting, so
   * apply the rule now, before the game reads the setting.
   */
  private async handleLogLaunch(appId: number, actionId: number) {
    await this.host.sleep(UI_LAUNCH_GRACE_MS);
    this.pruneLaunches();
    if (this.seenRecently(`ui:action:${actionId}`, 60_000) || this.seenRecently(`ui:app:${appId}`, 30_000)) {
      this.host.log("info", `App ${appId} launched from this machine's UI`);
      return;
    }
    if (this.streamingTo || !this.config.enabled) return;

    const candidates = this.devices.filter((d) => isOnline(d) && this.targetFor(d.name).target);
    if (candidates.length === 0) {
      this.host.log("info", `App ${appId} launched remotely; no online device has a rule`);
      return;
    }
    // Steam doesn't say which device asked until the stream connects. With
    // several candidates, guess the one that streamed most recently; the
    // stream itself confirms or corrects the guess.
    const lastSeen = (name: string) => this.config.devices[name] ?? 0;
    candidates.sort((a, b) => lastSeen(b.name) - lastSeen(a.name) || a.name.localeCompare(b.name));
    const device = candidates[0].name;
    const note = candidates.length > 1 ? `, most recently used of ${candidates.length} online devices` : "";

    await this.applyRule(device, `App ${appId} launched remotely (${device}${note})`);

    this.clearRemoteLaunchTimer();
    this.remoteLaunchTimer = this.host.setTimer(() => {
      this.remoteLaunchTimer = undefined;
      this.enqueue(async () => {
        if (!this.streamingTo && this.config.session?.device === device) {
          await this.restore("remote launch didn't start a stream");
        }
      });
    }, REMOTE_LAUNCH_TIMEOUT_MS);
  }

  /** Makes the setting match the rule for `device`. */
  private async applyRule(device: string, reason: string) {
    const { target, waiting } = this.targetFor(device);
    const session = this.config.session;

    if (waiting) {
      this.host.log("info", `${reason}; waiting for ${device} to report its screen size`);
      return;
    }
    if (!target) {
      if (session) await this.restore(`${reason}; no rule for ${device}`);
      else this.host.log("info", `${reason}; no rule, leaving resolution alone`);
      return;
    }

    const current = this.readCurrent();
    if (current === undefined) {
      // Without knowing the current value we couldn't put it back later, so
      // don't touch anything.
      this.host.log("error", `${reason}; can't read Maximum Game Resolution, not changing it`);
      this.warn(
        "unreadable",
        "Can't read Maximum Game Resolution from Steam, so Gaugeshift isn't changing it. A Steam update may have changed how it works.",
      );
      return;
    }
    this.clearWarning("unreadable");

    let previous: string;
    if (session) {
      if (session.applied === target && current === target) {
        if (session.device !== device) {
          this.config.session = { ...session, device };
          await this.save();
        }
        return;
      }
      if (current !== session.applied) {
        // Changed by hand while our change was active. Respect it: treat
        // the new value as what to restore.
        this.host.log("info", `${reason}; setting was changed to ${current} by hand, adopting it`);
        previous = current;
      } else {
        previous = session.previous;
      }
    } else {
      if (current === target) {
        this.host.log("info", `${reason}; already at ${target}`);
        return;
      }
      previous = current;
    }

    // Record what to restore BEFORE changing anything, so a crash in
    // between can't lose the original value.
    this.config.session = { device, previous, applied: target, started: this.host.now() };
    await this.save();

    if (await this.writeWithRetry(target)) {
      this.clearWarning("apply-failed");
      this.host.log("info", `${reason}; Maximum Game Resolution ${current} -> ${target}`);
      this.host.toast("Gaugeshift", `Maximum Resolution: ${target}`);
      return;
    }

    const now = this.readCurrent();
    if (now === previous) this.config.session = null;
    else this.config.session = { ...this.config.session, applied: now ?? target };
    await this.save();
    this.host.log("error", `${reason}; couldn't set ${target} (Steam reports ${now})`);
    this.warn("apply-failed", `Couldn't change Maximum Game Resolution to ${target} for ${device}.`);
    this.host.toast("Gaugeshift", `Couldn't change to ${target}`);
  }

  /** Puts back the value from before the stream, if Gaugeshift changed it. */
  private async restore(reason: string) {
    const session = this.config.session;
    if (!session) return;
    this.clearRemoteLaunchTimer();

    const current = this.readCurrent();
    if (current !== undefined && current !== session.applied) {
      this.host.log("info", `${reason}; setting was changed to ${current} by hand, leaving it`);
      this.config.session = null;
      await this.save();
      this.clearWarning("restore-failed");
      return;
    }

    if (await this.writeWithRetry(session.previous)) {
      this.host.log("info", `${reason}; Maximum Game Resolution -> ${session.previous}`);
      this.config.session = null;
      await this.save();
      this.clearWarning("restore-failed");
      return;
    }

    // Keep the session so the restore is retried on the next stream event,
    // the next start, or the "Restore" button.
    this.host.log("error", `${reason}; couldn't restore ${session.previous}`);
    this.warn(
      "restore-failed",
      `Couldn't put Maximum Game Resolution back to ${session.previous}. Use "Restore" to try again, or set it in Settings → Display.`,
    );
    this.host.toast("Gaugeshift", `Couldn't restore ${session.previous}`);
  }

  private async writeWithRetry(value: string): Promise<boolean> {
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
      try {
        if (await this.host.writeResolution(value)) return true;
      } catch (e) {
        this.host.log("warning", `Setting ${value} failed (attempt ${attempt}): ${e}`);
      }
      if (attempt < WRITE_ATTEMPTS) await this.host.sleep(500 * attempt);
    }
    return false;
  }
}
