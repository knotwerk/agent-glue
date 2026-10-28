#!/usr/bin/env zsh
set -euo pipefail

script_dir="${0:A:h}"
workspace="${AGENT_GLUE_WORKSPACE:-$PWD}"
# Keep generated tasks in extension/state storage, never in the workspace.
tasks_file="${AGENT_GLUE_TASKS_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-glue/tasks.json}"
mkdir -p "${tasks_file:h}"
state_script="$script_dir/agent-tmux-state.zsh"

if ! command -v jq >/dev/null 2>&1; then
  print -u2 -- "jq is required to generate VS Code tmux restore tasks"
  exit 1
fi

if [[ ! -r "$state_script" ]]; then
  print -u2 -- "missing $state_script"
  exit 1
fi

source "$state_script"

live_json="$(agent_tmux_live_json)"
agent_tmux_update_recent "$live_json"
recent_json="$(agent_tmux_recent_json "$workspace")"

jq -n \
  --arg attach "$script_dir/agent-tmux-attach.zsh" \
  --arg restore "$script_dir/agent-tmux-restore.zsh" \
  --argjson live "$live_json" \
  --argjson recent "$recent_json" '
    def task_presentation: {
      reveal: "silent",
      focus: false,
      panel: "dedicated",
      clear: false,
      showReuseMessage: false,
      echo: false
    };
    def task_run_options: { reevaluateOnRerun: true };
    def disambiguator($row):
      " [" + $row.program + " " + (if ($row.stamp // "") != "" then $row.stamp else $row.session end) + "]";
    def resume_key($row):
      $row.program + "\u0001" + ($row.resume_id // "");
    def live_task($row; $duplicate_sessions):
      {
        label: (
          "agent: " + $row.title +
          (if ($duplicate_sessions | index($row.session)) then disambiguator($row) else "" end)
        ),
        detail: ($row.session + " - " + $row.program + (if ($row.resume_command // "") != "" then " - " + $row.resume_command else "" end)),
        type: "process",
        command: $attach,
        args: [$row.session, $row.title],
        problemMatcher: [],
        presentation: task_presentation,
        runOptions: task_run_options
      };
    def restore_task($row):
      {
        label: ("agent restore: " + $row.title + disambiguator($row)),
        detail: (($row.resume_command // "") + " -> " + $row.session),
        type: "process",
        command: $restore,
        args: [
          $row.program,
          $row.session,
          $row.title,
          (($row.created // 0) | tostring),
          ($row.cwd // ""),
          ($row.resume_id // "")
        ],
        problemMatcher: [],
        presentation: task_presentation,
        runOptions: task_run_options
      };

    ($live | sort_by(.created, .session)) as $live_rows
    | ($live_rows | group_by(.title) | map(select(length > 1) | .[].session)) as $duplicate_sessions
    | ($live_rows | map(.session)) as $live_sessions
    | ($live_rows | map(select((.resume_id // "") != "") | resume_key(.))) as $live_resume_keys
    | ($recent
        | map(select(
            ((.resume_id // "") != "")
            and (.session as $s | $live_sessions | index($s) | not)
            and (
              resume_key(.) as $k
              | $live_resume_keys
              | index($k)
              | not
            )
          ))
        | sort_by(.updated // .created // 0)
        | reverse
        | .[:25]
      ) as $restore_rows
    | {
        version: "2.0.0",
        tasks: (
          ($live_rows | map(live_task(.; $duplicate_sessions))) +
          ($restore_rows | map(restore_task(.)))
        )
      }
  ' > "$tasks_file"

chmod +x "$script_dir/agent-tmux-attach.zsh" "$script_dir/agent-tmux-rename.zsh" "$script_dir/agent-tmux-restore.zsh" "$state_script" "$0" 2>/dev/null || true
print -- "wrote $tasks_file"
