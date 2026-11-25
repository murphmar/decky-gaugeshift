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
import { FaExpandArrowsAlt } from "react-icons/fa";
import { Controller, ViewState } from "./controller";

const NO_CHANGE = "";
const CUSTOM = "__custom__";

/** Parses "1920x1200" (also "1920 x 1200", "1920*1200"); returns null if invalid. */
function parseResolution(text: string): string | null {
  const m = text.trim().toLowerCase().match(/^(\d{3,5})\s*[x×*]\s*(\d{3,5})$/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w < 320 || h < 200 || w > 7680 || h > 4320) return null;
  return `${w}x${h}`;
}

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

const RESOLUTIONS = [
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

function deviceNames(v: ViewState): string[] {
  const names = new Set<string>([
    ...Object.keys(v.config?.devices ?? {}),
    ...Object.keys(v.config?.rules ?? {}),
    ...v.paired,
  ]);
  if (v.streamingTo) names.add(v.streamingTo);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function Content({ controller }: { controller: Controller }) {
  const [view, setView] = useState<ViewState>(controller.view());
  useEffect(() => controller.subscribe(setView), [controller]);

  const config = view.config;
  if (!config) {
    return (
      <PanelSection>
        <PanelSectionRow>Loading…</PanelSectionRow>
      </PanelSection>
    );
  }

  const devices = deviceNames(view);
  const session = config.session;

  let status: string;
  if (!view.streamingTo) status = "Not streaming";
  else if (session) status = `Streaming to ${view.streamingTo}: set to ${session.applied}, will restore ${session.previous}`;
  else status = `Streaming to ${view.streamingTo}: no change`;

  const optionsFor = (name: string) => {
    const rule = config.rules[name];
    const list = [...RESOLUTIONS];
    if (rule && !list.includes(rule)) list.push(rule);
    return [
      { data: NO_CHANGE, label: "Don't change" },
      ...list.map((r) => ({ data: r, label: r })),
      { data: CUSTOM, label: "Custom…" },
    ];
  };

  const onPick = (name: string, value: string) => {
    if (value === CUSTOM) {
      const rule = config.rules[name];
      showModal(
        <CustomResolutionModal
          device={name}
          initial={rule && rule !== "Native" ? rule : ""}
          onSave={(v) => controller.setRule(name, v)}
        />,
      );
      return;
    }
    controller.setRule(name, value);
  };

  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <ToggleField
            label="Enabled"
            description="Change Maximum Game Resolution while a device streams from this machine."
            checked={config.enabled}
            onChange={(v) => controller.setEnabled(v)}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ fontSize: "12px", lineHeight: "16px", padding: "4px 0" }}>
            <div>{status}</div>
            <div style={{ opacity: 0.6 }}>Current setting: {view.current ?? "unknown"}</div>
          </div>
        </PanelSectionRow>
        {session && (
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => controller.restoreNow()}>
              Restore {session.previous} now
            </ButtonItem>
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Devices">
        {devices.length === 0 && (
          <PanelSectionRow>
            <div style={{ fontSize: "12px", opacity: 0.8 }}>
              Stream to this machine once from Steam Link or another Steam device and it will show up here.
            </div>
          </PanelSectionRow>
        )}
        {devices.map((name) => (
          <PanelSectionRow key={name}>
            <DropdownItem
              label={name}
              description={name === view.streamingTo ? "Streaming now" : undefined}
              rgOptions={optionsFor(name)}
              selectedOption={config.rules[name] ?? NO_CHANGE}
              onChange={(o) => onPick(name, String(o.data))}
            />
          </PanelSectionRow>
        ))}
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
  const controller = new Controller();
  controller.start().catch((e) => console.error("[Gaugeshift] start failed", e));

  return {
    name: "Gaugeshift",
    titleView: <div className={staticClasses.Title}>Gaugeshift</div>,
    content: <Content controller={controller} />,
    icon: <FaExpandArrowsAlt />,
    onDismount() {
      controller.stop();
    },
  };
});
