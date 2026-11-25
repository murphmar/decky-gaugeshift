import {
  ButtonItem,
  ConfirmModal,
  DropdownItem,
  PanelSection,
  PanelSectionRow,
  TextField,
  ToggleField,
  showModal,
  staticClasses,
} from "@decky/ui";
import { definePlugin } from "@decky/api";
import { useEffect, useState } from "react";
import { FaExchangeAlt } from "react-icons/fa";
import { DeviceView, Engine, MATCH, NONE, NewDevicesRule, ViewState, parseResolution } from "./engine";
import { startEngine, steamHost } from "./host";

const CUSTOM = "__custom__";

const PRESETS = [
  "1280x720",
  "1280x800",
  "1600x900",
  "1920x1080",
  "1920x1200",
  "2560x1440",
  "2560x1600",
  "3840x2160",
  "Native",
];

const small = { fontSize: "12px", lineHeight: "16px" } as const;

function CustomResolutionModal(props: {
  device: string;
  initial: string;
  onSave: (value: string) => void;
  closeModal?: () => void;
}) {
  const [text, setText] = useState(props.initial);
  const parsed = parseResolution(text);
  return (
    <ConfirmModal
      strTitle={`Custom resolution for ${props.device}`}
      strOKButtonText="Save"
      bOKDisabled={!parsed}
      onOK={() => {
        if (parsed) props.onSave(parsed);
        props.closeModal?.();
      }}
      onCancel={() => props.closeModal?.()}
      closeModal={props.closeModal}
    >
      <TextField
        label="Width x height"
        description={parsed ? `Will use ${parsed}` : "For example 2560x1080. Between 320x200 and 7680x4320."}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </ConfirmModal>
  );
}

function statusText(v: ViewState): string {
  const session = v.config.session;
  if (!v.streamingTo) {
    return session ? `Not streaming (waiting to restore ${session.previous})` : "Not streaming";
  }
  if (session) return `Streaming to ${v.streamingTo}: ${session.applied}, restores ${session.previous}`;
  const device = v.devices.find((d) => d.name === v.streamingTo);
  if (v.config.enabled && device?.rule === MATCH && !device.screen) {
    return `Streaming to ${v.streamingTo}: waiting for its screen size`;
  }
  return `Streaming to ${v.streamingTo}: no change`;
}

function matchLabel(d: DeviceView): string {
  if (!d.screen) return "Match screen (learned when it streams)";
  return d.screenAssumed ? `Match screen (${d.screen}, Steam Deck)` : `Match screen (${d.screen})`;
}

function deviceDescription(d: DeviceView): string | undefined {
  const parts: string[] = [];
  if (d.streaming) parts.push("Streaming now");
  else if (d.online) parts.push("Online");
  if (d.ruleIsDefault) parts.push("using the New devices setting");
  return parts.length ? parts.join(" · ") : undefined;
}

const NEW_DEVICE_OPTIONS: { data: NewDevicesRule; label: string }[] = [
  { data: MATCH, label: "Match their screen" },
  { data: NONE, label: "Don't change" },
];

function Content({ engine }: { engine: Engine | null }) {
  const [view, setView] = useState<ViewState | null>(engine?.view() ?? null);
  useEffect(() => (engine ? engine.subscribe(setView) : undefined), [engine]);

  if (!engine || !view) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div style={small}>Starting…</div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const { config } = view;
  const session = config.session;

  const optionsFor = (d: DeviceView) => {
    const list = [...PRESETS];
    if (d.rule !== MATCH && d.rule !== NONE && !list.includes(d.rule)) list.push(d.rule);
    return [
      { data: MATCH, label: matchLabel(d) },
      { data: NONE, label: "Don't change" },
      ...list.map((r) => ({ data: r, label: r })),
      { data: CUSTOM, label: "Custom…" },
    ];
  };

  const onPick = (name: string, rule: string, value: string) => {
    if (value === CUSTOM) {
      showModal(
        <CustomResolutionModal
          device={name}
          initial={parseResolution(rule) ? rule : ""}
          onSave={(v) => engine.setRule(name, v)}
        />,
      );
      return;
    }
    engine.setRule(name, value);
  };

  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <ToggleField
            label="Enabled"
            description="Change Maximum Game Resolution while a device streams from this machine."
            checked={config.enabled}
            onChange={(v) => engine.setEnabled(v)}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ ...small, padding: "4px 0" }}>
            <div>{statusText(view)}</div>
            <div style={{ opacity: 0.6 }}>Current setting: {view.current ?? "unknown"}</div>
          </div>
        </PanelSectionRow>
        {view.warnings.map((w) => (
          <PanelSectionRow key={w.kind}>
            <div style={{ ...small, color: "#ffb347" }}>⚠ {w.message}</div>
          </PanelSectionRow>
        ))}
        {session && (
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => engine.restoreNow()}>
              Restore {session.previous} now
            </ButtonItem>
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Devices">
        {view.devices.length === 0 && (
          <PanelSectionRow>
            <div style={{ ...small, opacity: 0.8 }}>
              Stream to this machine once from Steam Link or another Steam device and it will show up here.
            </div>
          </PanelSectionRow>
        )}
        {view.devices.map((d) => (
          <PanelSectionRow key={d.name}>
            <DropdownItem
              layout="below"
              menuLabel={`Resolution for ${d.name}`}
              label={d.name}
              description={deviceDescription(d)}
              rgOptions={optionsFor(d)}
              selectedOption={d.rule}
              onChange={(o) => onPick(d.name, d.rule, String(o.data))}
            />
          </PanelSectionRow>
        ))}
      </PanelSection>

      <PanelSection title="New devices">
        <PanelSectionRow>
          <DropdownItem
            layout="below"
            label="The first time a device streams"
            description="Match their screen uses the size the device reports (1280x800 for a Steam Deck)."
            menuLabel="New devices"
            rgOptions={NEW_DEVICE_OPTIONS}
            selectedOption={config.newDevices}
            onChange={(o) => engine.setNewDevices(o.data as NewDevicesRule)}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection>
        <PanelSectionRow>
          <div style={{ fontSize: "11px", lineHeight: "14px", opacity: 0.6 }}>
            Applies to games launched while streaming. Games with their own resolution set in Properties keep it.
          </div>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

export default definePlugin(() => {
  let engine: Engine | null = null;
  let disconnect: (() => void) | null = null;
  let unloaded = false;
  const ready = startEngine()
    .then((started) => {
      if (unloaded) {
        started.disconnect();
        void started.engine.stop();
        return;
      }
      engine = started.engine;
      disconnect = started.disconnect;
    })
    .catch((e) => steamHost.log("error", `Failed to start: ${e}`));

  function Panel() {
    const [e, setE] = useState<Engine | null>(engine);
    useEffect(() => {
      if (e) return undefined;
      let active = true;
      void ready.then(() => {
        if (active) setE(engine);
      });
      return () => {
        active = false;
      };
    }, [e]);
    return <Content engine={e} />;
  }

  return {
    name: "Gaugeshift",
    titleView: <div className={staticClasses.Title}>Gaugeshift</div>,
    content: <Panel />,
    icon: <FaExchangeAlt />,
    onDismount() {
      unloaded = true;
      disconnect?.();
      engine?.stop();
    },
  };
});
