const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  agentSummary,
  emptyAgentFields,
} = require("./warp-tabs-detection-fixture.cjs");

test("marks a tab as Claude Code when a live commands row has running claude", () => {
  const tab = { id: 4, tab_index: 3, active_tab_index: 0, cwd: "/repo/worktree" };
  const panes = [
    {
      uuid_hex: "pane-4",
      conversation_ids: null,
      active_conversation_id: null,
      cwd: "/repo/worktree",
    },
  ];
  const latestBlocksByUuid = {
    "pane-4": {
      command: "wt",
      start_ts: "2026-05-30 02:05:47.104883197",
      completed_ts: "2026-05-30 02:05:48.365489247",
      agent_view_visibility: '{"Terminal":{"pending_conversation_ids":[],"conversation_ids":[]}}',
    },
  };
  const runningCommandsByCwd = {
    "/repo/worktree": [
      {
        command: "claude -c",
        start_ts: "2026-05-30 02:05:51.407290773",
        completed_ts: null,
        exit_code: null,
      },
    ],
  };

  assert.deepEqual(
    agentSummary(tab, panes, latestBlocksByUuid, runningCommandsByCwd, {}),
    {
      agent_label: "Claude Code",
      agent_status: "running",
      agent_started_at: "2026-05-30 02:05:51.407290773",
      agent_completed_at: null,
      agent_command: "claude -c",
      agent_pending_count: 0,
      agent_conversation_count: 0,
    },
  );
});

test("does not mark a tab as Claude Code for suspended Ctrl+Z commands", () => {
  const tab = { id: 3, tab_index: 2, active_tab_index: 0, cwd: "/repo" };
  const panes = [
    {
      uuid_hex: "pane-3",
      conversation_ids: null,
      active_conversation_id: null,
      cwd: "/repo",
    },
  ];
  const latestBlocksByUuid = {};
  const runningCommandsByCwd = {
    "/repo": [
      {
        command: "claude",
        start_ts: "2026-05-30 00:39:34.989273338",
        completed_ts: "2026-05-30 00:43:25.250829653",
        exit_code: 148,
      },
    ],
  };

  assert.deepEqual(agentSummary(tab, panes, latestBlocksByUuid, runningCommandsByCwd, {}), emptyAgentFields());
});
