import {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  Icon,
  List,
  Toast,
  closeMainWindow,
  getPreferenceValues,
  showHUD,
  showToast,
} from "@vicinae/api";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { useCallback, useEffect, useMemo, useState } from "react";

const execFileAsync = promisify(execFile);
const WARP_DESKTOP_ID = "dev.warp.Warp.desktop";

type KeySender = "auto" | "wtype" | "ydotool" | "xdotool" | "none";

type Preferences = {
  warpStatePath?: string;
  keySender?: KeySender;
  focusDelayMs?: string;
};

type RawWarpTab = {
  id: number;
  window_id: number;
  tab_index: number;
  window_tab_count: number;
  active_tab_index: number;
  custom_title: string | null;
  color: string | null;
  focused_vertical_title: string | null;
  vertical_title: string | null;
  focused_cwd: string | null;
  cwd: string | null;
  focused_kind: string | null;
  pane_kinds: string | null;
};

type WarpTab = {
  id: number;
  windowId: number;
  tabIndex: number;
  windowTabCount: number;
  activeTabIndex: number;
  title: string;
  cwd?: string;
  isActive: boolean;
  isLast: boolean;
  kind: string;
  paneKinds: string[];
};

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function warpStatePath(preferences: Preferences): string {
  const configuredPath = preferences.warpStatePath?.trim() || "~/.local/state/warp-terminal";
  return expandHome(configuredPath);
}

function warpDatabasePath(preferences: Preferences): string {
  return path.join(warpStatePath(preferences), "warp.sqlite");
}

function cwdTitle(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const base = path.basename(cwd);
  return base || cwd;
}

function normalizeTab(row: RawWarpTab): WarpTab {
  const cwd = row.focused_cwd || row.cwd || undefined;
  const paneKinds = (row.pane_kinds || "")
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  const kind = row.focused_kind || paneKinds[0] || "tab";
  const title =
    row.custom_title ||
    row.focused_vertical_title ||
    row.vertical_title ||
    cwdTitle(cwd) ||
    `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ${row.tab_index + 1}`;

  return {
    id: row.id,
    windowId: row.window_id,
    tabIndex: row.tab_index,
    windowTabCount: row.window_tab_count,
    activeTabIndex: row.active_tab_index,
    title,
    cwd,
    isActive: row.tab_index === row.active_tab_index,
    isLast: row.tab_index === row.window_tab_count - 1,
    kind,
    paneKinds,
  };
}

async function loadWarpTabs(preferences: Preferences): Promise<WarpTab[]> {
  const dbPath = warpDatabasePath(preferences);
  if (!existsSync(dbPath)) {
    throw new Error(`Warp database not found at ${dbPath}`);
  }

  const script = `
import json
import sqlite3
import sys

con = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
con.row_factory = sqlite3.Row
rows = con.execute("""
WITH ordered_tabs AS (
  SELECT
    t.id,
    t.window_id,
    t.custom_title,
    t.color,
    ROW_NUMBER() OVER (PARTITION BY t.window_id ORDER BY t.id) - 1 AS tab_index,
    COUNT(*) OVER (PARTITION BY t.window_id) AS window_tab_count
  FROM tabs t
),
pane_summary AS (
  SELECT
    pn.tab_id,
    GROUP_CONCAT(DISTINCT pl.kind) AS pane_kinds,
    MAX(CASE WHEN pl.is_focused = 1 THEN pl.kind END) AS focused_kind,
    MAX(CASE WHEN pl.is_focused = 1 THEN pl.custom_vertical_tabs_title END) AS focused_vertical_title,
    MAX(pl.custom_vertical_tabs_title) AS vertical_title,
    MAX(CASE WHEN pl.is_focused = 1 AND tp.cwd IS NOT NULL THEN tp.cwd END) AS focused_cwd,
    MAX(tp.cwd) AS cwd
  FROM pane_nodes pn
  JOIN pane_leaves pl ON pl.pane_node_id = pn.id
  LEFT JOIN terminal_panes tp ON tp.id = pl.pane_node_id AND tp.kind = pl.kind
  GROUP BY pn.tab_id
)
SELECT
  ot.id,
  ot.window_id,
  ot.tab_index,
  ot.window_tab_count,
  w.active_tab_index,
  ot.custom_title,
  ot.color,
  ps.focused_vertical_title,
  ps.vertical_title,
  ps.focused_cwd,
  ps.cwd,
  ps.focused_kind,
  ps.pane_kinds
FROM ordered_tabs ot
JOIN windows w ON w.id = ot.window_id
LEFT JOIN pane_summary ps ON ps.tab_id = ot.id
ORDER BY ot.window_id, ot.tab_index
""").fetchall()
print(json.dumps([dict(row) for row in rows]))
`;

  const { stdout } = await execFileAsync("python3", ["-c", script, dbPath], {
    maxBuffer: 1024 * 1024,
  });

  return (JSON.parse(stdout) as RawWarpTab[]).map(normalizeTab);
}

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function focusExistingWarp(): Promise<boolean> {
  if (!isGnomeWayland() || !(await commandExists("gdbus"))) {
    return false;
  }

  try {
    await execFileAsync("gdbus", [
      "call",
      "--session",
      "--dest",
      "org.gnome.Shell",
      "--object-path",
      "/org/gnome/Shell",
      "--method",
      "org.gnome.Shell.FocusApp",
      WARP_DESKTOP_ID,
    ]);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveKeySender(preference: KeySender): Promise<KeySender | undefined> {
  if (preference === "none") {
    return undefined;
  }

  if (preference !== "auto") {
    return (await commandExists(preference)) ? preference : undefined;
  }

  for (const command of autoKeySenders()) {
    if (await commandExists(command)) return command;
  }

  return undefined;
}

function isGnomeWayland(): boolean {
  const sessionType = process.env.XDG_SESSION_TYPE?.toLowerCase();
  const desktop = `${process.env.XDG_CURRENT_DESKTOP || ""}:${process.env.DESKTOP_SESSION || ""}`.toLowerCase();
  return sessionType === "wayland" && desktop.includes("gnome");
}

function autoKeySenders(): KeySender[] {
  if (isGnomeWayland()) {
    return ["ydotool", "wtype", "xdotool"];
  }

  return ["wtype", "ydotool", "xdotool"];
}

function keySenderInstallMessage(): string {
  if (isGnomeWayland()) {
    return "Install ydotool and start ydotool.service to switch existing Warp tabs on GNOME Wayland. From the repo, run npm run setup:system.";
  }

  return "Install wtype, ydotool, or xdotool to switch existing Warp tabs. From the repo, run npm run setup:system.";
}

function ydotoolSocketPath(): string | undefined {
  if (process.env.YDOTOOL_SOCKET) return process.env.YDOTOOL_SOCKET;

  const candidates = [
    "/run/ydotool/socket",
    process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, ".ydotool_socket") : undefined,
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => existsSync(candidate));
}

function keySenderErrorMessage(sender: KeySender, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  if (sender === "ydotool") {
    return `ydotool is installed, but ydotoold is not reachable or not permitted. Start ydotool.service and make its socket accessible. ${message}`;
  }

  return message;
}

function tabShortcutNumber(tab: WarpTab): number | undefined {
  const oneBasedIndex = tab.tabIndex + 1;
  if (oneBasedIndex <= 8) return oneBasedIndex;
  if (tab.isLast) return 9;
  return undefined;
}

async function sendCtrlNumber(sender: KeySender, number: number): Promise<void> {
  if (sender === "wtype") {
    await execFileAsync("wtype", ["-M", "ctrl", "-k", String(number), "-m", "ctrl"]);
    return;
  }

  if (sender === "xdotool") {
    await execFileAsync("xdotool", ["key", `ctrl+${number}`]);
    return;
  }

  if (sender === "ydotool") {
    const keyCode = number === 9 ? 10 : number + 1;
    const socket = ydotoolSocketPath();
    await execFileAsync("ydotool", ["key", "29:1", `${keyCode}:1`, `${keyCode}:0`, "29:0"], {
      env: socket ? { ...process.env, YDOTOOL_SOCKET: socket } : process.env,
    });
    return;
  }

  throw new Error(`Unsupported key sender: ${sender}`);
}

async function openWarpNewTab(cwd?: string): Promise<void> {
  const uri = cwd
    ? `warp://action/new_tab?path=${encodeURIComponent(cwd)}`
    : "warp://action/new_tab";

  if (await commandExists("xdg-open")) {
    spawnDetached("xdg-open", [uri]);
    return;
  }

  spawnDetached("warp-terminal", cwd ? [uri] : []);
}

async function switchToTab(tab: WarpTab, preferences: Preferences): Promise<void> {
  if (tab.isActive) {
    await closeMainWindow();
    await focusExistingWarp();
    await showHUD(`Opened ${tab.title}`);
    return;
  }

  const shortcutNumber = tabShortcutNumber(tab);
  if (!shortcutNumber) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Cannot switch directly",
      message: "Warp only exposes direct shortcuts for tabs 1-8 and the last tab. Use the explicit new-tab action if you want a duplicate.",
    });
    return;
  }

  const sender = await resolveKeySender(preferences.keySender || "auto");
  if (!sender) {
    await showToast({
      style: Toast.Style.Failure,
      title: "No key sender available",
      message: `${keySenderInstallMessage()} The selected tab was not duplicated.`,
    });
    return;
  }

  await closeMainWindow();
  await focusExistingWarp();
  const focusDelay = Number.parseInt(preferences.focusDelayMs || "200", 10);
  await sleep(Number.isFinite(focusDelay) ? focusDelay : 200);
  try {
    await sendCtrlNumber(sender, shortcutNumber);
    await showHUD(`Opened ${tab.title}`);
  } catch (err) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Could not switch tab",
      message: keySenderErrorMessage(sender, err),
    });
  }
}

function tabSubtitle(tab: WarpTab): string {
  return [tab.cwd, `Window ${tab.windowId}`, `Tab ${tab.tabIndex + 1}`].filter(Boolean).join(" - ");
}

function tabAccessories(tab: WarpTab): List.Item.Accessory[] {
  const accessories: List.Item.Accessory[] = [
    { text: `#${tab.tabIndex + 1}` },
    { text: tab.kind },
  ];

  if (tab.isActive) {
    accessories.unshift({ tag: { value: "Active", color: Color.Green } });
  }

  return accessories;
}

function detailMarkdown(tab: WarpTab): string {
  return [
    `# ${tab.title}`,
    "",
    `- Window: ${tab.windowId}`,
    `- Tab: ${tab.tabIndex + 1} of ${tab.windowTabCount}`,
    `- Active in window: ${tab.isActive ? "yes" : "no"}`,
    `- Pane kind: ${tab.kind}`,
    tab.paneKinds.length > 0 ? `- Pane kinds: ${tab.paneKinds.join(", ")}` : undefined,
    tab.cwd ? `- CWD: \`${tab.cwd}\`` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function TabActions({
  tab,
  onSwitch,
  onReload,
}: {
  tab: WarpTab;
  onSwitch: (tab: WarpTab) => void;
  onReload: () => void;
}) {
  return (
    <ActionPanel>
      <Action title="Open Tab" icon={Icon.Window} onAction={() => onSwitch(tab)} />
      <Action title="Open New Warp Tab at CWD" icon={Icon.Terminal} onAction={() => openWarpNewTab(tab.cwd)} />
      {tab.cwd ? <Action.CopyToClipboard title="Copy CWD" icon={Icon.CopyClipboard} content={tab.cwd} /> : null}
      <Action
        title="Copy Tab Summary"
        icon={Icon.CopyClipboard}
        onAction={() => Clipboard.copy(`${tab.title}\n${tabSubtitle(tab)}`)}
      />
      <Action title="Reload" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["ctrl"], key: "r" }} onAction={onReload} />
    </ActionPanel>
  );
}

export default function Command() {
  const preferences = useMemo(() => getPreferenceValues<Preferences>(), []);
  const [tabs, setTabs] = useState<WarpTab[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showingDetail, setShowingDetail] = useState(false);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      setTabs(await loadWarpTabs(preferences));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setTabs([]);
      await showToast({ style: Toast.Style.Failure, title: "Could not load Warp tabs", message });
    } finally {
      setIsLoading(false);
    }
  }, [preferences]);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleSwitch = useCallback(
    (tab: WarpTab) => {
      switchToTab(tab, preferences).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        showToast({ style: Toast.Style.Failure, title: "Could not open tab", message });
      });
    },
    [preferences],
  );

  if (error && !isLoading) {
    return (
      <List isLoading={isLoading}>
        <List.EmptyView
          title="Could not load Warp tabs"
          description={error}
          icon={Icon.ExclamationMark}
          actions={
            <ActionPanel>
              <Action title="Reload" icon={Icon.ArrowClockwise} onAction={reload} />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={showingDetail}
      searchBarPlaceholder="Search Warp tabs..."
      actions={
        <ActionPanel>
          <Action
            title={showingDetail ? "Hide Details" : "Show Details"}
            icon={showingDetail ? Icon.EyeDisabled : Icon.Eye}
            onAction={() => setShowingDetail((value) => !value)}
          />
          <Action title="Reload" icon={Icon.ArrowClockwise} onAction={reload} />
        </ActionPanel>
      }
    >
      {tabs.length === 0 && !isLoading ? (
        <List.EmptyView title="No Warp tabs found" description="Open Warp, then reload this command." icon={Icon.Terminal} />
      ) : null}
      <List.Section title={`${tabs.length} Tabs`}>
        {tabs.map((tab) => (
          <List.Item
            key={`${tab.windowId}-${tab.id}`}
            title={tab.title}
            subtitle={tabSubtitle(tab)}
            icon={{ source: Icon.Terminal, tintColor: tab.isActive ? Color.Green : Color.SecondaryText }}
            keywords={[tab.cwd || "", `window ${tab.windowId}`, `tab ${tab.tabIndex + 1}`, tab.kind]}
            accessories={showingDetail ? [] : tabAccessories(tab)}
            detail={<List.Item.Detail markdown={detailMarkdown(tab)} />}
            actions={<TabActions tab={tab} onSwitch={handleSwitch} onReload={reload} />}
          />
        ))}
      </List.Section>
    </List>
  );
}
