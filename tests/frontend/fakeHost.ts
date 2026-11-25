import type { Config, Host, LogLevel } from "../../src/engine";
import { Engine, defaultConfig } from "../../src/engine";

/** A pretend Steam: holds the setting, records everything, and runs timers on demand. */
export class FakeHost implements Host {
  resolution: string | undefined = "1920x1080";
  unreadable = false;
  /** How many upcoming writes should fail. */
  failWrites = 0;
  writes: string[] = [];
  saved: Config[] = [];
  logs: Array<[LogLevel, string]> = [];
  /** Notifications shown, as "title | body". */
  toasts: string[] = [];
  /** Ordered record of writes and saves, to check what happens first. */
  events: string[] = [];
  failSave = false;
  time = 1_000_000;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  private nextId = 1;

  readResolution() {
    return this.unreadable ? undefined : this.resolution;
  }

  async writeResolution(value: string) {
    this.writes.push(value);
    this.events.push(`write ${value}`);
    if (this.failWrites > 0) {
      this.failWrites--;
      return false;
    }
    this.resolution = value;
    return !this.unreadable;
  }

  async saveConfig(config: Config) {
    if (this.failSave) throw new Error("disk full");
    this.saved.push(config);
    this.events.push(`save session=${config.session ? config.session.applied : "none"}`);
  }

  log(level: LogLevel, message: string) {
    this.logs.push([level, message]);
  }

  toast(title: string, body: string) {
    this.toasts.push(`${title} | ${body}`);
  }

  now() {
    return this.time;
  }

  async sleep(ms: number) {
    this.time += ms;
  }

  setTimer(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.push({ id, at: this.time + ms, fn });
    return id;
  }

  clearTimer(handle: unknown) {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** Moves time forward, running any timers that come due. */
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.fn();
    }
    this.time = end;
  }

  get pendingTimers() {
    return this.timers.length;
  }

  get lastSaved(): Config | undefined {
    return this.saved[this.saved.length - 1];
  }

  hasLog(level: LogLevel, fragment: string) {
    return this.logs.some(([l, m]) => l === level && m.includes(fragment));
  }
}

export interface Setup {
  host: FakeHost;
  engine: Engine;
}

/**
 * Creates an engine the way the plugin does at start-up: with saved
 * settings, then Steam's first report of the stream state.
 */
export async function setup(
  options: { config?: Partial<Config>; streaming?: string; resolution?: string } = {},
): Promise<Setup> {
  const host = new FakeHost();
  if (options.resolution !== undefined) host.resolution = options.resolution;
  const engine = new Engine(host, { ...defaultConfig(), ...options.config });
  await engine.onStreamState(options.streaming ?? "");
  return { host, engine };
}
