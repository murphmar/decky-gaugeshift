// Thin wrappers around the Steam client APIs this plugin relies on.
// None of these are officially documented, so everything is defensive.

declare const SteamClient: any;
declare const settingsStore: any;

// Field number of `gamescope_game_resolution_global` in Steam's client
// settings message (a string field). Taken from Steam's own UI code.
const GAME_RESOLUTION_FIELD = 21012;

function varint(value: number): number[] {
  const out: number[] = [];
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  out.push(value);
  return out;
}

function encodeStringSetting(field: number, value: string): string {
  const bytes = new TextEncoder().encode(value);
  const tag = varint((field << 3) | 2); // wire type 2 = length-delimited
  const all = [...tag, ...varint(bytes.length), ...bytes];
  let binary = "";
  for (const b of all) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Current Maximum Game Resolution ("Default", "Native", "1920x1200", ...). */
export function getGameResolution(): string | undefined {
  try {
    const v = settingsStore?.m_ClientSettings?.gamescope_game_resolution_global;
    return typeof v === "string" && v ? v : undefined;
  } catch {
    return undefined;
  }
}

export async function setGameResolution(value: string): Promise<void> {
  await SteamClient.Settings.SetSetting(
    encodeStringSetting(GAME_RESOLUTION_FIELD, value),
  );
}

/** Sets the value, then waits for Steam to report it back. */
export async function setGameResolutionVerified(value: string): Promise<boolean> {
  await setGameResolution(value);
  for (let i = 0; i < 20; i++) {
    if (getGameResolution() === value) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return getGameResolution() === value;
}

export interface StreamState {
  /** Name of the device being streamed to, or "" when not streaming. */
  clientName: string;
  sessionId: number;
}

/**
 * Calls `cb` with the current streaming state right away and whenever it
 * changes. Returns an unregister function.
 */
export function onStreamStateChanged(cb: (s: StreamState) => void): () => void {
  const handle = SteamClient.RemotePlay.RegisterForSettingsChanges((s: any) => {
    cb({
      clientName: typeof s?.strStreamingClientName === "string" ? s.strStreamingClientName : "",
      sessionId: Number(s?.unStreamingSessionID ?? 0) || 0,
    });
  });
  return () => {
    try {
      handle?.unregister?.();
    } catch {
      /* ignore */
    }
  };
}

export interface RemoteDevice {
  name: string;
  /** "Paired" (known but offline), "Connected" (online), "Streaming", ... */
  status: string;
}

/** Calls `cb` with the devices Steam knows for Remote Play / Steam Link. */
export function onDevicesChanged(cb: (devices: RemoteDevice[]) => void): () => void {
  const handle = SteamClient.RemotePlay.RegisterForDevicesChanges((devices: any[]) => {
    cb(
      (Array.isArray(devices) ? devices : [])
        .map((d) => ({
          name: typeof d?.clientName === "string" ? d.clientName : "",
          status: typeof d?.status === "string" ? d.status : "",
        }))
        .filter((d) => d.name),
    );
  });
  return () => {
    try {
      handle?.unregister?.();
    } catch {
      /* ignore */
    }
  };
}

/**
 * Calls `cb` when a game launch is started from this machine's own Steam UI
 * (including over Steam Link). Launches requested by a remote Steam client
 * do not trigger this.
 */
export function onUiLaunchStarted(cb: (appId: number, actionId: number) => void): () => void {
  const handle = SteamClient.Apps.RegisterForGameActionStart(
    (actionId: any, appId: any) => cb(Number(appId), Number(actionId)),
  );
  return () => {
    try {
      handle?.unregister?.();
    } catch {
      /* ignore */
    }
  };
}
