import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  Color,
  Icon,
  List,
  Toast,
  WindowManagement,
  closeMainWindow,
  confirmAlert,
  getPreferenceValues,
  showHUD,
  showToast,
} from "@vicinae/api";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const execFileAsync = promisify(execFile);
const WARP_DESKTOP_ID = "dev.warp.Warp.desktop";
const CLAUDE_COLOR = "#E08A5A";
const INTERACTION_REFRESH_INTERVAL_MS = 1000;

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
  window_width: number | null;
  window_height: number | null;
  origin_x: number | null;
  origin_y: number | null;
  custom_title: string | null;
  color: string | null;
  focused_vertical_title: string | null;
  vertical_title: string | null;
  focused_cwd: string | null;
  cwd: string | null;
  focused_kind: string | null;
  pane_kinds: string | null;
  agent_label: string | null;
  agent_status: AgentStatus | null;
  agent_started_at: string | null;
  agent_completed_at: string | null;
  agent_command: string | null;
  agent_pending_count: number;
  agent_conversation_count: number;
};

type AgentStatus = "running" | "unread" | "done";

type AgentSession = {
  label: string;
  status: AgentStatus;
  startedAt?: string;
  completedAt?: string;
  command?: string;
  pendingCount: number;
  conversationCount: number;
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
  agent?: AgentSession;
  windowBounds?: WindowBounds;
  git?: GitInfo;
};

type WindowBounds = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

type GitInfo = {
  repoName: string;
  root: string;
  branch: string;
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

function formatHomePath(value: string): string {
  const home = homedir();
  if (value === home) return "~";
  if (value.startsWith(`${home}${path.sep}`)) return `~/${value.slice(home.length + 1)}`;
  return value;
}

function abbreviatePath(value?: string, tailCount = 2): string | undefined {
  if (!value) return undefined;

  const homeFormatted = formatHomePath(path.normalize(value));
  const isHomePath = homeFormatted === "~" || homeFormatted.startsWith("~/");
  const prefix = isHomePath ? "~" : homeFormatted.startsWith(path.sep) ? path.sep : "";
  const withoutPrefix = isHomePath
    ? homeFormatted.slice(2)
    : prefix === path.sep
      ? homeFormatted.slice(1)
      : homeFormatted;
  const parts = withoutPrefix.split(path.sep).filter(Boolean);

  if (parts.length <= tailCount) return homeFormatted;

  const tail = parts.slice(-tailCount).join(path.sep);
  return `...${path.sep}${tail}`;
}

function normalizeAgent(row: RawWarpTab): AgentSession | undefined {
  if (!row.agent_status || !row.agent_label) return undefined;

  return {
    label: row.agent_label,
    status: row.agent_status,
    startedAt: row.agent_started_at || undefined,
    completedAt: row.agent_completed_at || undefined,
    command: row.agent_command || undefined,
    pendingCount: row.agent_pending_count || 0,
    conversationCount: row.agent_conversation_count || 0,
  };
}

function normalizeWindowBounds(row: RawWarpTab): WindowBounds | undefined {
  const bounds = {
    x: row.origin_x ?? undefined,
    y: row.origin_y ?? undefined,
    width: row.window_width ?? undefined,
    height: row.window_height ?? undefined,
  };

  return Object.values(bounds).some((value) => value !== undefined) ? bounds : undefined;
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
    agent: normalizeAgent(row),
    windowBounds: normalizeWindowBounds(row),
  };
}

async function loadGitInfo(cwd?: string): Promise<GitInfo | undefined> {
  if (!cwd) return undefined;

  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], {
      maxBuffer: 128 * 1024,
      timeout: 1000,
    });
    const [root, branch] = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (!root || !branch) return undefined;

    return {
      repoName: path.basename(root),
      root,
      branch,
    };
  } catch {
    return undefined;
  }
}

async function attachGitInfo(tabs: WarpTab[]): Promise<WarpTab[]> {
  const gitInfoByCwd = new Map<string, Promise<GitInfo | undefined>>();

  return Promise.all(
    tabs.map(async (tab) => {
      if (!tab.cwd) return tab;

      let gitInfo = gitInfoByCwd.get(tab.cwd);
      if (!gitInfo) {
        gitInfo = loadGitInfo(tab.cwd);
        gitInfoByCwd.set(tab.cwd, gitInfo);
      }
      const git = await gitInfo;

      return git ? { ...tab, git } : tab;
    }),
  );
}

async function loadWarpTabs(preferences: Preferences): Promise<WarpTab[]> {
  const dbPath = warpDatabasePath(preferences);
  if (!existsSync(dbPath)) {
    throw new Error(`Warp database not found at ${dbPath}`);
  }

  const script = `
import json
import re
import sqlite3
import sys

con = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
con.row_factory = sqlite3.Row
ANSI_RE = re.compile(r"\\x1b\\[[0-9;?]*[ -/]*[@-~]")
CLAUDE_RE = re.compile(r"^(?:\\S+/)?claude(?:[-\\s]|$)")

def plain_command(value):
    if value is None:
        return None
    if isinstance(value, bytes):
        text = value.decode("utf-8", "replace")
    else:
        text = str(value)
    return ANSI_RE.sub("", text).replace("\\r", "").strip()

def is_claude_command(command):
    if not command:
        return False
    first_line = command.splitlines()[0].strip()
    return bool(CLAUDE_RE.match(first_line))

def parse_json_list(value):
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, str)]

def extend_unique(target, values):
    for value in values:
        if value and value not in target:
            target.append(value)

def visibility_ids(value):
    pending = []
    conversations = []
    if not value:
        return pending, conversations
    try:
        data = json.loads(value)
    except Exception:
        return pending, conversations

    terminal = data.get("Terminal") if isinstance(data, dict) else None
    if isinstance(terminal, dict):
        extend_unique(pending, terminal.get("pending_conversation_ids") or [])
        extend_unique(conversations, terminal.get("conversation_ids") or [])

    agent = data.get("Agent") if isinstance(data, dict) else None
    if isinstance(agent, dict):
        extend_unique(pending, agent.get("pending_other_conversation_ids") or [])
        extend_unique(conversations, agent.get("other_conversation_ids") or [])
        for key in ("conversation_id", "origin_conversation_id"):
            value = agent.get(key)
            if isinstance(value, str):
                extend_unique(conversations, [value])

    return pending, conversations

def agent_label_for_conversations(conversation_ids, conversation_models):
    models = [conversation_models.get(conversation_id) for conversation_id in conversation_ids]
    if any(isinstance(model, str) and "claude" in model.lower() for model in models):
        return "Claude Agent"
    return "Warp Agent"

base_rows = con.execute("""
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
  w.window_width,
  w.window_height,
  w.origin_x,
  w.origin_y,
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

pane_rows = con.execute("""
SELECT
  pn.tab_id,
  pl.is_focused,
  tp.id AS pane_id,
  hex(tp.uuid) AS uuid_hex,
  tp.cwd,
  tp.conversation_ids,
  tp.active_conversation_id
FROM pane_nodes pn
JOIN pane_leaves pl ON pl.pane_node_id = pn.id
JOIN terminal_panes tp ON tp.id = pl.pane_node_id AND tp.kind = pl.kind
ORDER BY pn.tab_id, pl.is_focused DESC, tp.id
""").fetchall()

latest_block_rows = con.execute("""
WITH ranked_blocks AS (
  SELECT
    hex(pane_leaf_uuid) AS uuid_hex,
    start_ts,
    completed_ts,
    exit_code,
    agent_view_visibility,
    stylized_command,
    ROW_NUMBER() OVER (PARTITION BY pane_leaf_uuid ORDER BY id DESC) AS rn
  FROM blocks
)
SELECT
  uuid_hex,
  start_ts,
  completed_ts,
  exit_code,
  agent_view_visibility,
  stylized_command
FROM ranked_blocks
WHERE rn = 1
""").fetchall()

conversation_model_rows = con.execute("""
SELECT
  conversation_id,
  json_extract(conversation_data, '$.conversation_usage_metadata.token_usage[0].model_id') AS model
FROM agent_conversations
""").fetchall()

running_command_rows = con.execute("""
SELECT
  id,
  command,
  start_ts,
  completed_ts,
  pwd
FROM commands
WHERE completed_ts IS NULL
ORDER BY id DESC
""").fetchall()

panes_by_tab_id = {}
for row in pane_rows:
    panes_by_tab_id.setdefault(row["tab_id"], []).append(dict(row))

latest_blocks_by_uuid = {}
for row in latest_block_rows:
    block = dict(row)
    block["command"] = plain_command(block.pop("stylized_command"))
    latest_blocks_by_uuid[block["uuid_hex"]] = block

conversation_models = {
    row["conversation_id"]: row["model"]
    for row in conversation_model_rows
    if row["conversation_id"]
}

running_claude_commands_by_pwd = {}
for row in running_command_rows:
    command = plain_command(row["command"])
    pwd = row["pwd"]
    if pwd and is_claude_command(command):
        running_claude_commands_by_pwd.setdefault(pwd, []).append({
            "command": command,
            "start_ts": row["start_ts"],
            "completed_ts": row["completed_ts"],
        })

def empty_agent_fields():
    return {
        "agent_label": None,
        "agent_status": None,
        "agent_started_at": None,
        "agent_completed_at": None,
        "agent_command": None,
        "agent_pending_count": 0,
        "agent_conversation_count": 0,
    }

def agent_summary(tab, panes):
    candidates = []
    is_active_tab = tab["tab_index"] == tab["active_tab_index"]

    for pane in panes:
        block = latest_blocks_by_uuid.get(pane["uuid_hex"])
        pending_ids = []
        conversation_ids = []
        extend_unique(conversation_ids, parse_json_list(pane.get("conversation_ids")))
        active_conversation_id = pane.get("active_conversation_id")
        if active_conversation_id:
            extend_unique(conversation_ids, [active_conversation_id])

        cwd = pane.get("cwd")
        running_claude_commands = running_claude_commands_by_pwd.get(cwd) if cwd else None
        if running_claude_commands:
            command = running_claude_commands[0]
            candidates.append({
                "agent_label": "Claude Code",
                "agent_status": "running",
                "agent_started_at": command.get("start_ts"),
                "agent_completed_at": command.get("completed_ts"),
                "agent_command": command.get("command"),
                "agent_pending_count": len(pending_ids),
                "agent_conversation_count": len(conversation_ids),
                "_priority": 40,
            })
            continue

        if block:
            pending_from_block, conversations_from_block = visibility_ids(block.get("agent_view_visibility"))
            extend_unique(pending_ids, pending_from_block)
            extend_unique(conversation_ids, conversations_from_block)

            if is_claude_command(block.get("command")) and block.get("exit_code") != 148:
                status = "running" if block.get("completed_ts") is None else ("done" if is_active_tab else "unread")
                if status != "running" and pending_ids:
                    status = "unread"
                candidates.append({
                    "agent_label": "Claude Code",
                    "agent_status": status,
                    "agent_started_at": block.get("start_ts"),
                    "agent_completed_at": block.get("completed_ts"),
                    "agent_command": block.get("command"),
                    "agent_pending_count": len(pending_ids),
                    "agent_conversation_count": len(conversation_ids),
                    "_priority": 30 if status == "running" else 20 if status == "unread" else 10,
                })
                continue

        if active_conversation_id or pending_ids or conversation_ids:
            status = "running" if active_conversation_id else "unread" if pending_ids else "done"
            candidates.append({
                "agent_label": agent_label_for_conversations(conversation_ids + pending_ids, conversation_models),
                "agent_status": status,
                "agent_started_at": None,
                "agent_completed_at": None,
                "agent_command": None,
                "agent_pending_count": len(pending_ids),
                "agent_conversation_count": len(conversation_ids),
                "_priority": 25 if status == "running" else 15 if status == "unread" else 5,
            })

    if not candidates:
        return empty_agent_fields()

    candidates.sort(key=lambda candidate: (
        candidate["_priority"],
        candidate.get("agent_started_at") or "",
    ), reverse=True)
    best = dict(candidates[0])
    best.pop("_priority", None)
    return best

rows = []
for row in base_rows:
    tab = dict(row)
    tab.update(agent_summary(tab, panes_by_tab_id.get(tab["id"], [])))
    rows.append(tab)

print(json.dumps(rows))
`;

  const { stdout } = await execFileAsync("python3", ["-c", script, dbPath], {
    maxBuffer: 1024 * 1024,
  });

  return attachGitInfo((JSON.parse(stdout) as RawWarpTab[]).map(normalizeTab));
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

function isWarpWindow(window: WindowManagement.Window): boolean {
  const app = window.application;
  const values = [app?.id, app?.name, app?.path].filter(Boolean).join(" ").toLowerCase();
  return values.includes("warp");
}

function windowMatchScore(window: WindowManagement.Window, bounds?: WindowBounds): number {
  if (!bounds) return window.active ? 0 : 1;

  const windowBounds = window.bounds;
  const diffs = [
    bounds.x !== undefined ? Math.abs(windowBounds.position.x - bounds.x) : undefined,
    bounds.y !== undefined ? Math.abs(windowBounds.position.y - bounds.y) : undefined,
    bounds.width !== undefined ? Math.abs(windowBounds.size.width - bounds.width) : undefined,
    bounds.height !== undefined ? Math.abs(windowBounds.size.height - bounds.height) : undefined,
  ].filter((value) => value !== undefined) as number[];

  if (diffs.length === 0) return window.active ? 0 : 1;
  return diffs.reduce((sum, value) => sum + value, 0);
}

async function focusWarpWindow(tab?: WarpTab): Promise<boolean> {
  try {
    const windows = await WindowManagement.getWindows();
    const warpWindows = windows.filter(isWarpWindow);
    if (warpWindows.length === 0) return await focusExistingWarp();

    const [target] = warpWindows.sort(
      (left, right) => windowMatchScore(left, tab?.windowBounds) - windowMatchScore(right, tab?.windowBounds),
    );
    return (await target.focus()) || (await focusExistingWarp());
  } catch {
    return await focusExistingWarp();
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
    "/tmp/.ydotool_socket",
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

function focusDelay(preferences: Preferences): number {
  const focusDelayMs = Number.parseInt(preferences.focusDelayMs || "200", 10);
  return Number.isFinite(focusDelayMs) ? focusDelayMs : 200;
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

async function sendCloseTab(sender: KeySender): Promise<void> {
  if (sender === "wtype") {
    await execFileAsync("wtype", ["-M", "ctrl", "-M", "shift", "-k", "w", "-m", "shift", "-m", "ctrl"]);
    return;
  }

  if (sender === "xdotool") {
    await execFileAsync("xdotool", ["key", "ctrl+shift+w"]);
    return;
  }

  if (sender === "ydotool") {
    const socket = ydotoolSocketPath();
    await execFileAsync("ydotool", ["key", "29:1", "42:1", "17:1", "17:0", "42:0", "29:0"], {
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
    await focusWarpWindow(tab);
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
  await focusWarpWindow(tab);
  await sleep(focusDelay(preferences));
  try {
    await sendCtrlNumber(sender, shortcutNumber);
    await focusWarpWindow(tab);
    await showHUD(`Opened ${tab.title}`);
  } catch (err) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Could not switch tab",
      message: keySenderErrorMessage(sender, err),
    });
  }
}

async function closeWarpTab(tab: WarpTab, preferences: Preferences): Promise<void> {
  const confirmed = await confirmAlert({
    title: `Close ${tab.title}?`,
    message: tab.cwd ? abbreviatePath(tab.cwd) : undefined,
    icon: Icon.Trash,
    primaryAction: { title: "Close Tab", style: Alert.ActionStyle.Destructive },
  });

  if (!confirmed) return;

  const shortcutNumber = tabShortcutNumber(tab);
  if (!tab.isActive && !shortcutNumber) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Cannot close directly",
      message: "Warp only exposes direct shortcuts for tabs 1-8 and the last tab. Select the tab in Warp to close it.",
    });
    return;
  }

  const sender = await resolveKeySender(preferences.keySender || "auto");
  if (!sender) {
    await showToast({
      style: Toast.Style.Failure,
      title: "No key sender available",
      message: `${keySenderInstallMessage()} The selected tab was not closed.`,
    });
    return;
  }

  await closeMainWindow();
  await focusWarpWindow(tab);
  await sleep(focusDelay(preferences));

  try {
    if (!tab.isActive && shortcutNumber) {
      await sendCtrlNumber(sender, shortcutNumber);
      await sleep(150);
      await focusWarpWindow(tab);
    }
    await sendCloseTab(sender);
    await showHUD(`Closed ${tab.title}`);
  } catch (err) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Could not close tab",
      message: keySenderErrorMessage(sender, err),
    });
  }
}

function tabSubtitle(tab: WarpTab): string {
  const gitParts = tab.git ? [tab.git.repoName, `git:${tab.git.branch}`] : [];
  return [...gitParts, abbreviatePath(tab.cwd), `Window ${tab.windowId}`, `Tab ${tab.tabIndex + 1}`]
    .filter(Boolean)
    .join(" - ");
}

function parseWarpTimestamp(value?: string): number | undefined {
  if (!value) return undefined;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const timestamp = Date.parse(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function agentDuration(tab: WarpTab, now: number): string | undefined {
  const startedAt = parseWarpTimestamp(tab.agent?.startedAt);
  if (!startedAt) return undefined;
  const completedAt = parseWarpTimestamp(tab.agent?.completedAt);
  const end = completedAt || now;
  return formatDuration(end - startedAt);
}

function isClaudeAgent(agent?: AgentSession): boolean {
  return agent?.label.toLowerCase().includes("claude") || false;
}

function tabIcon(tab: WarpTab) {
  const tintColor = isClaudeAgent(tab.agent) ? CLAUDE_COLOR : tab.isActive ? Color.Green : Color.SecondaryText;
  return { source: Icon.Terminal, tintColor };
}

function agentTag(agent: AgentSession): List.Item.Accessory {
  if (agent.status === "running") {
    return { tag: { value: `${agent.label} Running`, color: Color.Orange }, icon: Icon.CircleProgress };
  }

  if (agent.status === "unread") {
    return { tag: { value: `${agent.label} Unread`, color: Color.Yellow }, icon: Icon.Bell };
  }

  return { tag: { value: `${agent.label} Done`, color: Color.Green }, icon: Icon.CheckCircle };
}

function agentIconAccessory(agent: AgentSession): List.Item.Accessory {
  const statusIcon =
    agent.status === "running" ? Icon.CircleProgress : agent.status === "unread" ? Icon.Bell : Icon.CheckCircle;
  const statusLabel = agent.status === "running" ? "running" : agent.status === "unread" ? "finished and unread" : "finished";

  return {
    icon: { source: statusIcon, tintColor: CLAUDE_COLOR },
    tooltip: `${agent.label} ${statusLabel}`,
  };
}

function agentStatusLine(tab: WarpTab, now: number): string | undefined {
  if (!tab.agent) return undefined;

  const state =
    tab.agent.status === "running"
      ? "running"
      : tab.agent.status === "unread"
        ? "finished and unread"
        : "finished";
  const duration = agentDuration(tab, now);
  const parts = [`${tab.agent.label}: ${state}`];
  if (duration) parts.push(duration);
  return parts.join(" - ");
}

function tabAccessories(tab: WarpTab, now: number): List.Item.Accessory[] {
  const accessories: List.Item.Accessory[] = [
    { text: `#${tab.tabIndex + 1}` },
    { text: tab.kind },
  ];

  if (tab.git) {
    accessories.unshift({ tag: { value: tab.git.branch, color: Color.Yellow }, icon: Icon.Code });
  }

  if (tab.agent) {
    accessories.unshift(isClaudeAgent(tab.agent) ? agentIconAccessory(tab.agent) : agentTag(tab.agent));
    const duration = agentDuration(tab, now);
    if (duration) {
      accessories.splice(1, 0, { text: duration, icon: Icon.Stopwatch });
    }
  }

  if (tab.isActive) {
    accessories.unshift({ tag: { value: "Active", color: Color.Green } });
  }

  return accessories;
}

function detailMarkdown(tab: WarpTab, now: number): string {
  return [
    `# ${tab.title}`,
    "",
    `- Window: ${tab.windowId}`,
    `- Tab: ${tab.tabIndex + 1} of ${tab.windowTabCount}`,
    `- Active in window: ${tab.isActive ? "yes" : "no"}`,
    `- Pane kind: ${tab.kind}`,
    tab.paneKinds.length > 0 ? `- Pane kinds: ${tab.paneKinds.join(", ")}` : undefined,
    tab.git ? `- Repository: ${tab.git.repoName}` : undefined,
    tab.git ? `- Branch: \`${tab.git.branch}\`` : undefined,
    tab.cwd ? `- CWD: \`${formatHomePath(tab.cwd)}\`` : undefined,
    agentStatusLine(tab, now) ? `- Agent: ${agentStatusLine(tab, now)}` : undefined,
    tab.agent?.command ? `- Agent command: \`${tab.agent.command}\`` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function TabActions({
  tab,
  onSwitch,
  onClose,
  onReload,
}: {
  tab: WarpTab;
  onSwitch: (tab: WarpTab) => void;
  onClose: (tab: WarpTab) => void;
  onReload: () => void;
}) {
  return (
    <ActionPanel>
      <Action title="Open Tab" icon={Icon.Window} onAction={() => onSwitch(tab)} />
      <Action title="Open New Warp Tab at CWD" icon={Icon.Terminal} onAction={() => openWarpNewTab(tab.cwd)} />
      <Action
        title="Close Tab"
        icon={Icon.Trash}
        shortcut={{ modifiers: ["ctrl"], key: "d" }}
        style={Action.Style.Destructive}
        onAction={() => onClose(tab)}
      />
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
  const [now, setNow] = useState(Date.now());

  const reloadInFlightRef = useRef(false);
  const lastInteractionRefreshAtRef = useRef(0);

  const reload = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (reloadInFlightRef.current) return;

      reloadInFlightRef.current = true;
      setIsLoading(true);
      if (!silent) {
        setError(undefined);
      }
      try {
        setNow(Date.now());
        setTabs(await loadWarpTabs(preferences));
        if (silent) {
          setError(undefined);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setTabs([]);
        if (!silent) {
          await showToast({ style: Toast.Style.Failure, title: "Could not load Warp tabs", message });
        }
      } finally {
        setIsLoading(false);
        reloadInFlightRef.current = false;
      }
    },
    [preferences],
  );

  const forceReload = useCallback(() => {
    void reload();
  }, [reload]);

  const refreshFromInteraction = useCallback(() => {
    const nowMs = Date.now();
    if (nowMs - lastInteractionRefreshAtRef.current < INTERACTION_REFRESH_INTERVAL_MS) return;
    lastInteractionRefreshAtRef.current = nowMs;
    void reload({ silent: true });
  }, [reload]);

  const handleSelectionChange = useCallback(() => {
    refreshFromInteraction();
  }, [refreshFromInteraction]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!tabs.some((tab) => tab.agent?.status === "running")) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [tabs]);

  const handleSwitch = useCallback(
    (tab: WarpTab) => {
      switchToTab(tab, preferences).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        showToast({ style: Toast.Style.Failure, title: "Could not open tab", message });
      });
    },
    [preferences],
  );

  const handleClose = useCallback(
    (tab: WarpTab) => {
      closeWarpTab(tab, preferences).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        showToast({ style: Toast.Style.Failure, title: "Could not close tab", message });
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
              <Action title="Reload" icon={Icon.ArrowClockwise} onAction={forceReload} />
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
      onSelectionChange={handleSelectionChange}
      actions={
        <ActionPanel>
          <Action
            title={showingDetail ? "Hide Details" : "Show Details"}
            icon={showingDetail ? Icon.EyeDisabled : Icon.Eye}
            onAction={() => setShowingDetail((value) => !value)}
          />
          <Action title="Reload" icon={Icon.ArrowClockwise} onAction={forceReload} />
        </ActionPanel>
      }
    >
      {tabs.length === 0 && !isLoading ? (
        <List.EmptyView title="No Warp tabs found" description="Open Warp, then reload this command." icon={Icon.Terminal} />
      ) : null}
      <List.Section title={`${tabs.length} Tabs`}>
        {tabs.map((tab) => (
          <List.Item
            id={`${tab.windowId}-${tab.id}`}
            key={`${tab.windowId}-${tab.id}`}
            title={tab.title}
            subtitle={tabSubtitle(tab)}
            icon={tabIcon(tab)}
            keywords={[
              tab.cwd || "",
              abbreviatePath(tab.cwd) || "",
              `window ${tab.windowId}`,
              `tab ${tab.tabIndex + 1}`,
              tab.kind,
              tab.git?.repoName || "",
              tab.git?.branch || "",
              tab.agent?.label || "",
              tab.agent?.status || "",
            ]}
            accessories={showingDetail ? [] : tabAccessories(tab, now)}
            detail={<List.Item.Detail markdown={detailMarkdown(tab, now)} />}
            actions={<TabActions tab={tab} onSwitch={handleSwitch} onClose={handleClose} onReload={forceReload} />}
          />
        ))}
      </List.Section>
    </List>
  );
}
