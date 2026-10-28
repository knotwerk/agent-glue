#!/usr/bin/env zsh
set -u

script_dir="${0:A:h}"
state_script="$script_dir/agent-tmux-state.zsh"
program="${1:-}"
old_session="${2:-}"
title="${3:-}"
created="${4:-0}"
cwd="${5:-$PWD}"
resume_id="${6:-}"

if [[ -r "$state_script" ]]; then
  source "$state_script"
fi

if [[ -z "$program" || -z "$old_session" || -z "$title" ]]; then
  print -u2 -- "usage: agent-tmux-restore.zsh <program> <old-session> <title> <created> <cwd> [resume-id]"
  exit 2
fi

if [[ -z "$resume_id" ]]; then
  print -u2 -- "agent-tmux-restore: refusing bare resume without a resume id for $old_session"
  exit 2
fi

normalize_title() {
  print -r -- "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E \
        -e 's/[[:space:]_]+/-/g' \
        -e 's/[^[:alnum:].-]+/-/g' \
        -e 's/-+/-/g' \
        -e 's/^-+//' \
        -e 's/-+$//'
}

quote_cmd_args() {
  local out="" arg
  for arg in "$@"; do
    out+=" ${(q)arg}"
  done
  print -r -- "$out"
}

running_in_current_tmux_pane() {
  [[ -n "${TMUX:-}" && -n "${TMUX_PANE:-}" ]] || return 1

  local current_tty pane_tty
  current_tty="$(tty 2>/dev/null)" || return 1
  pane_tty="$(tmux display-message -p -t "$TMUX_PANE" '#{pane_tty}' 2>/dev/null)" || return 1

  [[ -n "$current_tty" && "$current_tty" == "$pane_tty" ]]
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

sync_tasks_later() {
  [[ -x "$script_dir/sync-agent-tmux-tasks.zsh" ]] || return 0
  (sleep 8; "$script_dir/sync-agent-tmux-tasks.zsh" >/dev/null 2>&1 || true) &!
}

title="$(normalize_title "$title")"
if [[ -z "$title" ]]; then
  print -u2 -- "restore title is empty after normalization"
  exit 2
fi

if tmux has-session -t "=$old_session" 2>/dev/null; then
  session="$old_session"
else
  if [[ "$old_session" == "${program}-"* ]]; then
    session="$old_session"
  else
    stamp="$(date +%Y%m%d_%H%M%S)"
    session="${program}-${title}-${stamp}"
    if tmux has-session -t "=$session" 2>/dev/null; then
      session="${program}-${title}-restore-${stamp}"
    fi
  fi

  case "$program" in
    codex)
      if [[ -n "$resume_id" ]]; then
        cmd="command codex resume$(quote_cmd_args "$resume_id")"
      else
        cmd="command codex resume"
      fi
      ;;
    codex2)
      codex_home="$HOME/.codex2"
      mkdir -p "$codex_home" || exit $?
      if [[ -n "$resume_id" ]]; then
        cmd="CODEX_HOME=${(q)codex_home} command codex resume$(quote_cmd_args "$resume_id")"
      else
        cmd="CODEX_HOME=${(q)codex_home} command codex resume"
      fi
      ;;
    codex3)
      codex_home="$HOME/.codex3"
      mkdir -p "$codex_home" || exit $?
      if [[ -n "$resume_id" ]]; then
        cmd="CODEX_HOME=${(q)codex_home} command codex resume$(quote_cmd_args "$resume_id")"
      else
        cmd="CODEX_HOME=${(q)codex_home} command codex resume"
      fi
      ;;
    codexl)
      codex_home="$HOME/.codexl"
      mkdir -p "$codex_home" || exit $?
      if [[ -n "$resume_id" ]]; then
        cmd="CODEX_HOME=${(q)codex_home} command codex resume$(quote_cmd_args "$resume_id")"
      else
        cmd="CODEX_HOME=${(q)codex_home} command codex resume"
      fi
      ;;
    claude)
      if [[ -n "$resume_id" ]]; then
        cmd="command claude --name$(quote_cmd_args "$title") --resume$(quote_cmd_args "$resume_id")"
      else
        cmd="command claude --name$(quote_cmd_args "$title") --resume"
      fi
      ;;
    claude2)
      claude_config_dir="$HOME/.claude2"
      mkdir -p "$claude_config_dir" || exit $?
      if [[ -n "$resume_id" ]]; then
        cmd="CLAUDE_CONFIG_DIR=${(q)claude_config_dir} command claude --name$(quote_cmd_args "$title") --resume$(quote_cmd_args "$resume_id")"
      else
        cmd="CLAUDE_CONFIG_DIR=${(q)claude_config_dir} command claude --name$(quote_cmd_args "$title") --resume"
      fi
      ;;
    claudel)
      claude_config_dir="$HOME/.claudel"
      mkdir -p "$claude_config_dir" || exit $?
      if [[ -n "$resume_id" ]]; then
        cmd="CLAUDE_CONFIG_DIR=${(q)claude_config_dir} command claude --name$(quote_cmd_args "$title") --resume$(quote_cmd_args "$resume_id")"
      else
        cmd="CLAUDE_CONFIG_DIR=${(q)claude_config_dir} command claude --name$(quote_cmd_args "$title") --resume"
      fi
      ;;
    claudelp)
      claude_config_dir="$HOME/.claudelp"
      mkdir -p "$claude_config_dir" || exit $?
      if [[ -n "$resume_id" ]]; then
        cmd="CLAUDE_CONFIG_DIR=${(q)claude_config_dir} command claude --name$(quote_cmd_args "$title") --resume$(quote_cmd_args "$resume_id")"
      else
        cmd="CLAUDE_CONFIG_DIR=${(q)claude_config_dir} command claude --name$(quote_cmd_args "$title") --resume"
      fi
      ;;
    *)
      print -u2 -- "unsupported agent program: $program"
      exit 2
      ;;
  esac

  mkdir -p "$cwd" 2>/dev/null || true
  if tmux new-session -d -s "$session" -c "$cwd"; then
    label_tmux_session "$session" "$title"
    if typeset -f agent_tmux_log_event >/dev/null 2>&1; then
      agent_tmux_log_event restore "$session" "$title" "$program" "$created" "$cwd" "$cmd" "$old_session" >/dev/null 2>&1 || true
    fi
    tmux send-keys -t "=$session" "cd ${(q)cwd} && $cmd" Enter
    sync_tasks_later
  elif ! tmux has-session -t "=$session" 2>/dev/null; then
    print -u2 -- "agent-tmux-restore: failed to create tmux session: $session"
    exit 1
  fi
fi

printf '\033]0;%s\a' "$title"
label_tmux_session "$session" "$title"

if running_in_current_tmux_pane; then
  tmux switch-client -t "=$session"
  exit $?
fi

exec env -u TMUX -u TMUX_PANE tmux attach-session -t "=$session"
