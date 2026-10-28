#!/usr/bin/env zsh
set -u

script_dir="${0:A:h}"
state_script="$script_dir/agent-tmux-state.zsh"
session="${1:-}"
title="${2:-$session}"

if [[ -r "$state_script" ]]; then
  source "$state_script"
fi

if [[ -z "$session" ]]; then
  print -u2 -- "usage: agent-tmux-attach.zsh <session> [title]"
  exit 2
fi

resolve_session() {
  local requested="$1"
  if tmux has-session -t "=$requested" 2>/dev/null; then
    print -r -- "$requested"
    return 0
  fi

  local prog stamp
  if [[ "$requested" =~ '^(codex|codex2|codex3|codexl|claude|claude2|claudel|claudelp)-(.+)-([0-9]{8}_[0-9]{6})$' ]]; then
    prog="${match[1]}"
    stamp="${match[3]}"
  elif [[ "$requested" =~ '^(codex|codex2|codex3|codexl|claude|claude2|claudel|claudelp)-([0-9]{8}_[0-9]{6})-(.+)$' ]]; then
    prog="${match[1]}"
    stamp="${match[2]}"
  else
    return 1
  fi

  local candidate found count=0
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    if [[ "$candidate" =~ "^${prog}-.+-${stamp}$" || "$candidate" =~ "^${prog}-${stamp}-.+$" ]]; then
      found="$candidate"
      (( count += 1 ))
    fi
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null)

  if (( count == 1 )); then
    print -r -- "$found"
    return 0
  fi

  return 1
}

sync_tasks() {
  [[ -x "$script_dir/sync-agent-tmux-tasks.zsh" ]] || return 0
  "$script_dir/sync-agent-tmux-tasks.zsh" >/dev/null 2>&1 || true
}

restore_from_recent() {
  local requested="$1"
  local row program old_session row_title created cwd resume_id
  [[ -s "${agent_tmux_recent_file:-}" && -x "$script_dir/agent-tmux-restore.zsh" ]] || return 1

  row="$(jq -r --arg session "$requested" '
    map(select(.session == $session)) | first |
    if . == null then empty
    else [.program, .session, .title, ((.created // 0) | tostring), (.cwd // ""), (.resume_id // "")] | @tsv
    end
  ' "$agent_tmux_recent_file" 2>/dev/null)" || return 1
  [[ -n "$row" ]] || return 1

  IFS=$'\t' read -r program old_session row_title created cwd resume_id <<< "$row"
  [[ -n "$program" && -n "$old_session" && -n "$row_title" ]] || return 1
  exec "$script_dir/agent-tmux-restore.zsh" "$program" "$old_session" "$row_title" "$created" "$cwd" "$resume_id"
}

resolved_session="$(resolve_session "$session" 2>/dev/null || true)"
if [[ -z "$resolved_session" ]]; then
  restore_from_recent "$session"
  print -u2 -- "tmux session not found: $session"
  exec zsh -l
fi
if [[ "$resolved_session" != "$session" ]]; then
  print -u2 -- "tmux session renamed: $session -> $resolved_session"
  session="$resolved_session"
  sync_tasks
fi

session_title_from_name() {
  local name="$1"
  if [[ "$name" =~ '^(codex|codex2|codex3|codexl|claude|claude2|claudel|claudelp)-(.+)-[0-9]{8}_[0-9]{6}$' ]]; then
    print -r -- "${match[2]}"
  elif [[ "$name" =~ '^(codex|codex2|codex3|codexl|claude|claude2|claudel|claudelp)-[0-9]{8}_[0-9]{6}-(.+)$' ]]; then
    print -r -- "${match[2]}"
  else
    print -r -- "$name"
  fi
}

label_tmux_session() {
  local target_session="$1" label="$2"
  local pane window

  tmux set-option -t "$target_session" @title "$label" >/dev/null 2>&1 || true

  while IFS= read -r window; do
    [[ -n "$window" ]] || continue
    tmux set-window-option -t "$window" automatic-rename off >/dev/null 2>&1 || true
    tmux set-window-option -t "$window" allow-set-title off >/dev/null 2>&1 || true
    tmux rename-window -t "$window" "$label" >/dev/null 2>&1 || true
  done < <(tmux list-windows -t "=$target_session" -F '#{window_id}' 2>/dev/null)

  while IFS= read -r pane; do
    [[ -n "$pane" ]] && tmux select-pane -t "$pane" -T "$label" >/dev/null 2>&1 || true
  done < <(tmux list-panes -t "=$target_session" -F '#{pane_id}' 2>/dev/null)

  tmux refresh-client -S 2>/dev/null || true
}

running_in_current_tmux_pane() {
  [[ -n "${TMUX:-}" && -n "${TMUX_PANE:-}" ]] || return 1

  local current_tty pane_tty
  current_tty="$(tty 2>/dev/null)" || return 1
  pane_tty="$(tmux display-message -p -t "$TMUX_PANE" '#{pane_tty}' 2>/dev/null)" || return 1

  [[ -n "$current_tty" && "$current_tty" == "$pane_tty" ]]
}

current_title="$(tmux show-option -qv -t "$session" @title 2>/dev/null || true)"
if [[ -n "$current_title" ]]; then
  title="$current_title"
elif [[ -z "$title" || "$title" == "$session" ]]; then
  title="$(session_title_from_name "$session")"
fi

printf '\033]0;%s\a' "$title"
label_tmux_session "$session" "$title"

if running_in_current_tmux_pane; then
  tmux switch-client -t "=$session"
  exit $?
fi

exec env -u TMUX -u TMUX_PANE tmux attach-session -t "=$session"
