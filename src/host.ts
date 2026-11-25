// Connects the engine to the real Steam client and the Python backend.

import { addEventListener, callable, removeEventListener, toaster } from "@decky/api";
import { Config, Engine, Host, LogLevel } from "./engine";
import {
  getGameResolution,
  onDevicesChanged,
  onStreamStateChanged,
  onUiLaunchStarted,
  setGameResolutionVerified,
} from "./steam";

const getConfig = callable<[], Config>("get_config");
const saveConfig = callable<[config: Config], Config>("save_config");
const backendLog = callable<[level: string, message: string], void>("log");

export const steamHost: Host = {
  readResolution: getGameResolution,
  writeResolution: setGameResolutionVerified,
  async saveConfig(config) {
    await saveConfig(config);
  },
  log(level: LogLevel, message: string) {
    const line = `[Gaugeshift] ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warning") console.warn(line);
    else console.log(line);
    backendLog(level, message).catch(() => {});
  },
  toast(title: string, body: string) {
    toaster.toast({ title, body });
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Creates the engine and connects it to Steam. Returns it plus a disconnect function. */
export async function startEngine(): Promise<{ engine: Engine; disconnect: () => void }> {
  const engine = new Engine(steamHost, await getConfig());
  const unsubs: Array<() => void> = [];
  unsubs.push(onDevicesChanged((d) => engine.onDevices(d)));
  unsubs.push(onUiLaunchStarted((appId, actionId) => engine.onUiLaunch(appId, actionId)));
  const listener = addEventListener<[appId: number, actionId: number]>("launch_started", (appId, actionId) => {
    engine.onLogLaunch(appId, actionId);
  });
  unsubs.push(() => removeEventListener("launch_started", listener));
  // Subscribe to the stream state last: its first report triggers recovery.
  unsubs.push(onStreamStateChanged(({ clientName }) => engine.onStreamState(clientName)));
  return { engine, disconnect: () => unsubs.forEach((u) => u()) };
}
