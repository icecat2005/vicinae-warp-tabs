const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const sourcePath = path.join(__dirname, "..", "src", "warp-tabs.tsx");

function loadEmbeddedPythonScript() {
  const source = readFileSync(sourcePath, "utf8");
  const match = source.match(/const script = `([\s\S]*?)`;\n\n  const \{ stdout \}/);
  assert.ok(match, "embedded Warp SQLite script should be extractable");
  return vm.runInNewContext(`\`${match[1]}\``);
}

function createWarpDb(rows) {
  const dir = mkdtempSync(path.join(tmpdir(), "warp-tabs-test-"));
  const dbPath = path.join(dir, "warp.sqlite");
  const setup = String.raw`
import json
import sqlite3
import sys

rows = json.loads(sys.stdin.read())
con = sqlite3.connect(sys.argv[1])
con.executescript('''
CREATE TABLE windows (
  id INTEGER PRIMARY KEY NOT NULL,
  active_tab_index INTEGER NOT NULL,
  window_width FLOAT,
  window_height FLOAT,
  origin_x FLOAT,
  origin_y FLOAT
);
CREATE TABLE tabs (
  id INTEGER PRIMARY KEY NOT NULL,
  window_id INTEGER NOT NULL,
  custom_title TEXT,
  color TEXT
);
CREATE TABLE pane_nodes (
  id INTEGER PRIMARY KEY NOT NULL,
  tab_id INTEGER NOT NULL,
  parent_pane_node_id INTEGER,
  flex FLOAT,
  is_leaf BOOLEAN NOT NULL
);
CREATE TABLE pane_leaves (
  pane_node_id INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  is_focused BOOLEAN NOT NULL DEFAULT FALSE,
  custom_vertical_tabs_title TEXT,
  PRIMARY KEY (pane_node_id, kind)
);
CREATE TABLE terminal_panes (
  id INTEGER PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL DEFAULT 'terminal',
  uuid BLOB NOT NULL UNIQUE,
  cwd TEXT,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  conversation_ids TEXT,
  active_conversation_id TEXT
);
CREATE TABLE blocks (
  id INTEGER PRIMARY KEY,
  pane_leaf_uuid BLOB NOT NULL,
  start_ts DATETIME,
  completed_ts DATETIME,
  exit_code INTEGER NOT NULL,
  agent_view_visibility TEXT,
  stylized_command BLOB NOT NULL
);
CREATE TABLE agent_conversations (
  id INTEGER PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  conversation_data TEXT NOT NULL
);
CREATE TABLE commands (
  id INTEGER NOT NULL PRIMARY KEY,
  command TEXT NOT NULL,
  exit_code INTEGER,
  start_ts DATETIME,
  completed_ts DATETIME,
  pwd TEXT,
  session_id BIGINTEGER,
  workflow_command TEXT,
  is_agent_executed BOOLEAN
);
''')
con.execute("INSERT INTO windows (id, active_tab_index, window_width, window_height, origin_x, origin_y) VALUES (1, 0, 1000, 800, 0, 0)")
for row in rows:
    uuid = bytes.fromhex(row['uuid_hex'])
    con.execute("INSERT INTO tabs (id, window_id, custom_title, color) VALUES (?, 1, NULL, NULL)", (row['tab_id'],))
    con.execute("INSERT INTO pane_nodes (id, tab_id, parent_pane_node_id, flex, is_leaf) VALUES (?, ?, NULL, NULL, 1)", (row['pane_node_id'], row['tab_id']))
    con.execute("INSERT INTO pane_leaves (pane_node_id, kind, is_focused, custom_vertical_tabs_title) VALUES (?, 'terminal', 1, NULL)", (row['pane_node_id'],))
    con.execute("INSERT INTO terminal_panes (id, kind, uuid, cwd, is_active, conversation_ids, active_conversation_id) VALUES (?, 'terminal', ?, ?, 1, NULL, NULL)", (row['pane_node_id'], uuid, row['cwd']))
    for block in row.get('blocks', []):
        con.execute("INSERT INTO blocks (id, pane_leaf_uuid, start_ts, completed_ts, exit_code, agent_view_visibility, stylized_command) VALUES (?, ?, ?, ?, ?, ?, ?)", (
            block['id'], uuid, block['start_ts'], block['completed_ts'], block['exit_code'], block.get('agent_view_visibility'), block['command'].encode()
        ))
for command in rows[0].get('commands', []):
    con.execute("INSERT INTO commands (id, command, exit_code, start_ts, completed_ts, pwd, session_id, workflow_command, is_agent_executed) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)", (
        command['id'], command['command'], command['exit_code'], command['start_ts'], command['completed_ts'], command['pwd'], command.get('session_id')
    ))
con.commit()
`;
  execFileSync("python3", ["-c", setup, dbPath], { input: JSON.stringify(rows) });
  return dbPath;
}

function readTabs(dbPath) {
  const stdout = execFileSync("python3", ["-c", loadEmbeddedPythonScript(), dbPath], { encoding: "utf8" });
  return JSON.parse(stdout);
}

test("marks a tab as Claude Code when commands has a live Claude command for that CWD", () => {
  const dbPath = createWarpDb([
    {
      tab_id: 4,
      pane_node_id: 7,
      uuid_hex: "32358807F06C4537A9F1830575249424",
      cwd: "/repo/worktree",
      blocks: [
        {
          id: 386,
          command: "wt",
          start_ts: "2026-05-30 02:05:47.104883197",
          completed_ts: "2026-05-30 02:05:48.365489247",
          exit_code: 0,
          agent_view_visibility: '{"Terminal":{"pending_conversation_ids":[],"conversation_ids":[]}}',
        },
      ],
      commands: [
        {
          id: 729,
          command: "claude -c",
          exit_code: null,
          start_ts: "2026-05-30 02:05:51.407290773",
          completed_ts: null,
          pwd: "/repo/worktree",
          session_id: 8218322527041907531,
        },
      ],
    },
  ]);

  const [tab] = readTabs(dbPath);

  assert.equal(tab.agent_label, "Claude Code");
  assert.equal(tab.agent_status, "running");
  assert.equal(tab.agent_started_at, "2026-05-30 02:05:51.407290773");
  assert.equal(tab.agent_completed_at, null);
  assert.equal(tab.agent_command, "claude -c");
});

test("does not mark suspended Ctrl+Z Claude commands as Claude tabs", () => {
  const dbPath = createWarpDb([
    {
      tab_id: 3,
      pane_node_id: 5,
      uuid_hex: "8CC483BE605B4A409472C27331A99D7D",
      cwd: "/repo",
      commands: [
        {
          id: 707,
          command: "claude",
          exit_code: 148,
          start_ts: "2026-05-30 00:39:34.989273338",
          completed_ts: "2026-05-30 00:43:25.250829653",
          pwd: "/repo",
          session_id: 5707805241649075655,
        },
      ],
    },
  ]);

  const [tab] = readTabs(dbPath);

  assert.equal(tab.agent_label, null);
  assert.equal(tab.agent_status, null);
  assert.equal(tab.agent_command, null);
});

test("does not mark suspended Ctrl+Z Claude blocks as Claude tabs", () => {
  const dbPath = createWarpDb([
    {
      tab_id: 3,
      pane_node_id: 5,
      uuid_hex: "8CC483BE605B4A409472C27331A99D7D",
      cwd: "/repo",
      blocks: [
        {
          id: 707,
          command: "claude",
          start_ts: "2026-05-30 00:39:34.989273338",
          completed_ts: "2026-05-30 00:43:25.250829653",
          exit_code: 148,
          agent_view_visibility: '{"Terminal":{"pending_conversation_ids":[],"conversation_ids":[]}}',
        },
      ],
    },
  ]);

  const [tab] = readTabs(dbPath);

  assert.equal(tab.agent_label, null);
  assert.equal(tab.agent_status, null);
  assert.equal(tab.agent_command, null);
});
