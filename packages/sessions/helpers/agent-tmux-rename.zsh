#!/usr/bin/env zsh
set -u

script_dir="${0:A:h}"
state_script="$script_dir/agent-tmux-state.zsh"

requested_session="${1:-}"
raw_title="${2:-}"
cwd_arg="${3:-$PWD}"
reason="${4:-rename}"
command_text="${5:-}"

if [[ -r "$state_script" ]]; then
  source "$state_script"
fi

usage() {
  print -u2 -- "usage: agent-tmux-rename.zsh <session> <title> [cwd] [reason] [command]"
}

normalize_title() {
  local title="$1"
  title=$(
    printf '%s' "$title" \
      | tr '[:upper:]' '[:lower:]' \
      | sed -E \
          -e 's/[[:space:]_]+/-/g' \
          -e 's/[^[:alnum:].-]+/-/g' \
          -e 's/-+/-/g' \
          -e 's/^-+//' \
          -e 's/-+$//'
  )
  if [[ -z "$title" ]]; then
    print -u2 -- "agent-tmux-rename: title is empty after normalization"
    return 2
  fi
  print -r -- "$title"
}

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

session_parts() {
  local session="$1" tagged_title="${2:-}"
  local program stem stamp

  if [[ "$session" =~ '^(codex|codex2|codex3|codexl|claude|claude2|claudel|claudelp)-(.+)-([0-9]{8}_[0-9]{6})$' ]]; then
    program="${match[1]}"
    stem="${match[2]}"
    stamp="${match[3]}"
  elif [[ "$session" =~ '^(codex|codex2|codex3|codexl|claude|claude2|claudel|claudelp)-([0-9]{8}_[0-9]{6})-(.+)$' ]]; then
    program="${match[1]}"
    stamp="${match[2]}"
    stem="${match[3]}"
  elif [[ "$session" =~ '^(codex|codex2|codex3|codexl|claude|claude2|claudel|claudelp)-(.+)$' ]]; then
    program="${match[1]}"
    stem="${match[2]}"
    stamp=""
  else
    return 1
  fi

  [[ -n "$stem" ]] || stem="$tagged_title"
  [[ -n "$stem" ]] || stem="$session"
  print -r -- "$program"$'\t'"$stem"$'\t'"$stamp"
}

unique_session_name() {
  local session="$1" program="$2" title="$3" stamp="$4"
  local candidate sid
  if [[ -n "$stamp" ]]; then
    candidate="${program}-${title}-${stamp}"
  else
    candidate="${program}-${title}"
  fi

  if [[ "$candidate" == "$session" ]] || ! tmux has-session -t "=$candidate" 2>/dev/null; then
    print -r -- "$candidate"
    return 0
  fi

  sid="$(tmux display-message -p -t "=$session" '#{session_id}' 2>/dev/null || true)"
  sid="${sid#\$}"
  if [[ -n "$sid" ]]; then
    if [[ -n "$stamp" ]]; then
      candidate="${program}-${title}-${sid}-${stamp}"
    else
      candidate="${program}-${title}-${sid}"
    fi
  fi
  print -r -- "$candidate"
}

label_tmux_session() {
  local target_session="$1" label="$2"
  local pane window

  tmux set-option -t "$target_session" @title "$label" >/dev/null 2>&1 || true
  tmux set-option -t "$target_session" @agent_user_named "$label" >/dev/null 2>&1 || true

  while IFS= read -r window; do
    [[ -n "$window" ]] || continue
    tmux set-window-option -t "$window" automatic-rename off >/dev/null 2>&1 || true
    tmux set-window-option -t "$window" allow-set-title off >/dev/null 2>&1 || true
    tmux rename-window -t "$window" "$label" >/dev/null 2>&1 || true
  done < <(tmux list-windows -t "=$target_session" -F '#{window_id}' 2>/dev/null)

  while IFS= read -r pane; do
    [[ -n "$pane" ]] && tmux select-pane -t "$pane" -T "$label" >/dev/null 2>&1 || true
  done < <(tmux list-panes -t "=$target_session" -F '#{pane_id}' 2>/dev/null)

  tmux refresh-client -S >/dev/null 2>&1 || true
}

sync_tasks() {
  [[ -x "$script_dir/sync-agent-tmux-tasks.zsh" ]] || return 0
  "$script_dir/sync-agent-tmux-tasks.zsh" >/dev/null 2>&1 || true
}

if [[ -z "$requested_session" || -z "$raw_title" ]]; then
  usage
  exit 2
fi

session="$(resolve_session "$requested_session" 2>/dev/null || true)"
if [[ -z "$session" ]]; then
  print -u2 -- "agent-tmux-rename: tmux session not found: $requested_session"
  exit 1
fi

title="$(normalize_title "$raw_title")" || exit $?
current_title="$(tmux show-option -qv -t "$session" @title 2>/dev/null || true)"
parts="$(session_parts "$session" "$current_title" 2>/dev/null)" || {
  print -u2 -- "agent-tmux-rename: unsupported agent session: $session"
  exit 1
}

IFS=$'\t' read -r program _stem stamp <<< "$parts"
old_session="$session"
new_session="$(unique_session_name "$session" "$program" "$title" "$stamp")"

if [[ "$new_session" != "$session" ]]; then
  tmux rename-session -t "=$session" "$new_session" || exit $?
fi

label_tmux_session "$new_session" "$title"
created="$(tmux display-message -p -t "=$new_session" '#{session_created}' 2>/dev/null || date +%s)"

if (( $+functions[agent_tmux_log_event] )); then
  agent_tmux_log_event "$reason" "$new_session" "$title" "$program" "$created" "$cwd_arg" "$command_text" "$old_session" >/dev/null 2>&1 || true
fi

sync_tasks
print -r -- "$new_session"
