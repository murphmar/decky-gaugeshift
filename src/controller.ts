// The part that reacts to streams starting and stopping.

import { addEventListener, callable, removeEventListener, toaster } from "@decky/api";
import {
  RemoteDevice,
  getGameResolution,
  onDevicesChanged,
  onStreamStateChanged,
  onUiLaunchStarted,
  setGameResolutionVerified,
} from "./steam";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long to wait for a stream after a remote launch before undoing. */
const REMOTE_LAUNCH_TIMEOUT_MS = 60_000;

export interface Session {
  device: string;
  previous: string;
  applied: string;
  started: number;
}

export interface Config {
  enabled: boolean;
  rules: Record<string, string>;
  devices: Record<string, number>;
  session: Session | null;
}

const getConfig = callable<[], Config>("get_config");
const setEnabledBackend = callable<[enabled: boolean], Config>("set_enabled");
const setRuleBackend = callable<[device: string, resolution: string], Config>("set_rule");
const noteDevice = callable<[device: string], Config>("note_device");
const forgetDeviceBackend = callable<[device: string], Config>("forget_device");
const beginSession = callable<[device: string, previous: string, applied: string], Config>("begin_session");
const endSession = callable<[], Config>("end_session");
const backendLog = callable<[level: string, message: string], void>("log");

function log(message: string, level: "info" | "warning" | "error" = "info") {
  console.log(`[Gaugeshift] ${message}`);
  backendLog(level, message).catch(() => {});
}

export interface ViewState {
  config: Config | null;
  streamingTo: string;
  paired: string[];
  current: string | undefined;
}

type Listener = (s: ViewState) => void;

export class Controller {
  private config: Config | null = null;
  private streamingTo = "";
  private devices: RemoteDevice[] = [];
  /** Recent launches started from this machine's own UI (action IDs and app IDs). */
  private uiLaunches = new Map<string, number>();
  private remoteLaunchTimer: ReturnType<typeof setTimeout> | undefined;
  private firstEvent = true;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<Listener>();
  private unsubs: Array<() => void> = [];

  async start() {
    this.config = await getConfig();
    this.unsubs.push(
      onDevicesChanged((devices) => {
        this.devices = devices;
        this.notify();
      }),
    );
    this.unsubs.push(
      onUiLaunchStarted((appId, actionId) => {
        const now = Date.now();
        this.uiLaunches.set(`action:${actionId}`, now);
        this.uiLaunches.set(`app:${appId}`, now);
      }),
    );
    const launchListener = addEventListener<[appId: number, actionId: number]>(
      "launch_started",
      (appId, actionId) => {
        this.enqueue(() => this.onLaunchStarted(appId, actionId));
      },
    );
    this.unsubs.push(() => removeEventListener("launch_started", launchListener));
    this.unsubs.push(
      onStreamStateChanged(({ clientName }) => {
        this.enqueue(() => this.onStreamState(clientName));
      }),
    );
  }

  /** Called when the plugin unloads (disabled, updated, uninstalled). */
  async stop() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.clearRemoteLaunchTimer();
    // Never leave the setting changed behind us.
    await this.enqueue(() => this.restore("plugin unloading"));
  }

  // ---- UI-facing ----------------------------------------------------

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.view());
    return () => this.listeners.delete(l);
  }

  view(): ViewState {
    return {
      config: this.config,
      streamingTo: this.streamingTo,
      paired: this.devices.map((d) => d.name),
      current: getGameResolution(),
    };
  }

  async setEnabled(enabled: boolean) {
    this.config = await setEnabledBackend(enabled);
    this.notify();
    if (!enabled) await this.enqueue(() => this.restore("turned off"));
    else if (this.streamingTo) await this.enqueue(() => this.applyRule(this.streamingTo, "turned on"));
  }

  async setRule(device: string, resolution: string) {
    this.config = await setRuleBackend(device, resolution);
    this.notify();
    // If that device is streaming right now, apply the change straight away.
    if (device === this.streamingTo) {
      await this.enqueue(() => this.applyRule(device, "rule changed"));
    }
  }

  async forgetDevice(device: string) {
    this.config = await forgetDeviceBackend(device);
    this.notify();
  }

  async restoreNow() {
    await this.enqueue(() => this.restore("restored manually"));
  }

  // ---- internals ------------------------------------------------------

  private notify() {
    const v = this.view();
    this.listeners.forEach((l) => l(v));
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    // Run handlers one at a time, in order, so quick connect/disconnect
    // sequences can't race each other.
    const next = this.queue.then(fn).catch((e) => log(`Error: ${e}`, "error"));
    this.queue = next;
    return next;
  }

  private async onStreamState(clientName: string) {
    const first = this.firstEvent;
    this.firstEvent = false;
    const previous = this.streamingTo;
    this.streamingTo = clientName;
    this.notify();

    if (first) {
      // Steam reports the current state as soon as we subscribe. Use it to
      // recover from a restart that happened mid-stream.
      const session = this.config?.session;
      if (session && !clientName) {
        await this.restore("recovering after restart");
      } else if (clientName && !session) {
        await this.onConnected(clientName);
      }
      return;
    }

    if (clientName) this.clearRemoteLaunchTimer();
    if (clientName === previous) return;
    if (previous) await this.restore(`${previous} disconnected`);
    if (clientName) await this.onConnected(clientName);
  }

  /**
   * The backend saw Steam start a launch. If it wasn't started from this
   * machine's UI and nothing is streaming yet, a remote Steam client (such
   * as a Steam Deck) asked for it. Apply that device's rule now, before the
   * game starts, rather than when its stream connects a few seconds later.
   */
  private async onLaunchStarted(appId: number, actionId: number) {
    // Give Steam's UI a moment to report launches it started itself.
    await sleep(400);
    const now = Date.now();
    for (const [key, t] of this.uiLaunches) if (now - t > 30_000) this.uiLaunches.delete(key);
    // Started from this machine's own UI (on the TV, or over Steam Link)?
    if (this.uiLaunches.has(`action:${actionId}`) || this.uiLaunches.has(`app:${appId}`)) {
      log(`App ${appId} launched from this machine's UI`);
      return;
    }
    if (this.streamingTo) return; // already streaming; that device's rule applies
    if (!this.config?.enabled) return;

    const rules = this.config.rules;
    const candidates = this.devices.filter(
      (d) => d.status !== "Paired" && d.status !== "" && rules[d.name],
    );
    if (candidates.length !== 1) {
      log(
        `App ${appId} launched remotely; ${candidates.length === 0 ? "no online device with a rule" : "several online devices with rules"}, waiting for the stream`,
      );
      return;
    }

    const device = candidates[0].name;
    await this.applyRule(device, `App ${appId} launched remotely (${device})`);

    // If no stream follows, the guess was wrong: put things back.
    this.clearRemoteLaunchTimer();
    this.remoteLaunchTimer = setTimeout(() => {
      this.remoteLaunchTimer = undefined;
      if (!this.streamingTo && this.config?.session?.device === device) {
        this.enqueue(() => this.restore("remote launch never started a stream"));
      }
    }, REMOTE_LAUNCH_TIMEOUT_MS);
  }

  private clearRemoteLaunchTimer() {
    if (this.remoteLaunchTimer) clearTimeout(this.remoteLaunchTimer);
    this.remoteLaunchTimer = undefined;
  }

  private async onConnected(device: string) {
    this.config = await noteDevice(device);
    this.notify();
    await this.applyRule(device, `${device} connected`);
  }

  /** Makes the setting match the rule for `device`, which is streaming now. */
  private async applyRule(device: string, reason: string) {
    if (!this.config) return;
    const target = this.config.enabled ? this.config.rules[device] : undefined;
    const session = this.config.session;

    if (!target) {
      if (session) await this.restore(`${reason}; no rule for ${device}`);
      else log(`${reason}; no rule for ${device}, leaving resolution alone`);
      return;
    }

    const current = getGameResolution() ?? "Default";
    if (session) {
      if (session.applied === target && current === target) return;
      // Keep the original value from before the stream; just switch target.
      this.config = await beginSession(device, session.previous, target);
    } else {
      if (current === target) {
        log(`${reason}; already at ${target}`);
        return;
      }
      // Record what to restore BEFORE changing anything.
      this.config = await beginSession(device, current, target);
    }

    const ok = await setGameResolutionVerified(target);
    this.notify();
    if (ok) {
      log(`${reason}; Maximum Game Resolution ${current} -> ${target}`);
      toaster.toast({
        title: "Gaugeshift",
        body: `Streaming to ${device}: games will run at up to ${target}`,
      });
    } else {
      log(`${reason}; tried to set ${target} but Steam reports ${getGameResolution()}`, "warning");
    }
  }

  private async restore(reason: string) {
    const session = this.config?.session;
    if (!session) return;

    const current = getGameResolution();
    if (current === session.applied || current === undefined) {
      const ok = await setGameResolutionVerified(session.previous);
      log(`${reason}; Maximum Game Resolution -> ${session.previous}${ok ? "" : " (not confirmed)"}`);
    } else {
      // Someone changed it by hand during the stream; respect that.
      log(`${reason}; resolution was changed to ${current} during the stream, leaving it`);
    }
    this.config = await endSession();
    this.notify();
  }
}
