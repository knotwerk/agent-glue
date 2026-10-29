#!/usr/bin/env zsh
set -u

agent_tmux_state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/agent-tmux"
agent_tmux_events_file="$agent_tmux_state_dir/events.jsonl"
agent_tmux_recent_file="$agent_tmux_state_dir/recent.json"

agent_tmux_ensure_state_dir() {
  mkdir -p "$agent_tmux_state_dir"
}

agent_tmux_physical_path() {
  local path="$1"
  if [[ -n "$path" ]]; then
    readlink -f "$path" 2>/dev/null || print -r -- "$path"
  fi
}

agent_tmux_session_fields() {
  local session="$1" tagged_title="$2" created="$3"
  local prog stem stamp title

  if [[ "$session" =~ '^(codex|codex2|codex3|codexl|claude|claude2|claudel|claudelp)-(.+)-([0-9]{8}_[0-9]{6})$' ]]; then
    prog="${match[1]}"
    stem="${match[2]}"
    stamp="${match[3]}"
  elif [[ "$session" =~ '^(codex|codex2|codex3|codexl|claude|claude2|claudel|claudelp)-([0-9]{8}_[0-9]{6})-(.+)$' ]]; then
    prog="${match[1]}"
    stamp="${match[2]}"
    stem="${match[3]}"
  elif [[ "$session" =~ '^(codex|codex2|codex3|codexl|claude|claude2|claudel|claudelp)-(.+)$' ]]; then
    [[ -n "$tagged_title" ]] || return 1
    prog="${match[1]}"
    stem="${match[2]}"
    stamp=""
  else
    return 1
  fi

  title="$tagged_title"
  [[ -n "$title" ]] || title="$stem"
  [[ -n "$title" ]] || title="$session"
  [[ "$created" == <-> ]] || created=0

  print -r -- "$session"$'\t'"$title"$'\t'"$created"$'\t'"$prog"$'\t'"$stamp"
}

agent_tmux_codex_home() {
  case "$1" in
    codex3) print -r -- "$HOME/.codex3" ;;
    codex2) print -r -- "$HOME/.codex2" ;;
    codexl) print -r -- "$HOME/.codexl" ;;
    codex)  print -r -- "$HOME/.codex" ;;
    *)      return 1 ;;
  esac
}

agent_tmux_claude_config_dir() {
  case "$1" in
    claude2) print -r -- "$HOME/.claude2" ;;
    claudel) print -r -- "$HOME/.claudel" ;;
    claudelp) print -r -- "$HOME/.claudelp" ;;
    claude)  print -r -- "$HOME/.claude" ;;
    *)       return 1 ;;
  esac
}

agent_tmux_stamp_epoch() {
  local stamp="$1"
  [[ "$stamp" =~ '^[0-9]{8}_[0-9]{6}$' ]] || return 1
  date -d "${stamp:0:4}-${stamp:4:2}-${stamp:6:2} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2}" +%s 2>/dev/null
}

agent_tmux_stamp_from_session() {
  local session="$1"
  if [[ "$session" =~ '^([^-]+)-.+-([0-9]{8}_[0-9]{6})$' ]]; then
    print -r -- "${match[2]}"
  elif [[ "$session" =~ '^([^-]+)-([0-9]{8}_[0-9]{6})-.+$' ]]; then
    print -r -- "${match[2]}"
  else
    return 1
  fi
}

agent_tmux_infer_codex_session_id() {
  local program="$1" created="$2" cwd="$3"
  local codex_home sessions_dir physical_cwd history result
  codex_home="$(agent_tmux_codex_home "$program")" || return 1
  sessions_dir="$codex_home/sessions"
  [[ -d "$sessions_dir" && "$created" == <-> ]] || return 1
  physical_cwd="$(agent_tmux_physical_path "$cwd")"

  result="$(
    find "$sessions_dir" -type f -name '*.jsonl' -printf '%T@\t%p\n' 2>/dev/null \
      | awk -F '\t' -v created="$created" '
          NF >= 2 {
            d = $1 - created
            if (d < 0) d = -d
            if (d <= 90) print d "\t" $2
          }
        ' \
      | sort -n \
      | head -10 \
      | while IFS=$'\t' read -r _diff file; do
          [[ -f "$file" ]] || continue
          head -1 "$file" 2>/dev/null | jq -r \
            --arg cwd "$cwd" \
            --arg physical_cwd "$physical_cwd" '
              select(.type == "session_meta") |
              .payload as $p |
              select($p.cwd == $cwd or $p.cwd == $physical_cwd) |
              $p.id
            ' 2>/dev/null
        done \
      | head -1
  )"
  if [[ -n "$result" ]]; then
    print -r -- "$result"
    return
  fi

  result="$(
    find "$sessions_dir" -type f -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null \
      | sort -nr \
      | head -120 \
      | while read -r _mtime file; do
          [[ -f "$file" ]] || continue
          head -1 "$file" 2>/dev/null | jq -r \
            --arg cwd "$cwd" \
            --arg physical_cwd "$physical_cwd" \
            --argjson created "$created" '
              select(.type == "session_meta") |
              .payload as $p |
              (($p.timestamp // "") | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601? // 0) as $start |
              select(($p.cwd == $cwd or $p.cwd == $physical_cwd) and $start >= ($created - 120) and $start <= ($created + 7200)) |
              [$start, $p.id] | @tsv
            ' 2>/dev/null
        done \
      | awk -F '\t' -v created="$created" '
          NF >= 2 {
            d = $1 - created
            if (d < 0) d = -d
            print d "\t" $2
          }
        ' \
      | sort -n \
      | head -1 \
      | cut -f2
  )"
  if [[ -n "$result" ]]; then
    print -r -- "$result"
    return
  fi

  result="$(
    find "$sessions_dir" -type f -name '*.jsonl' -printf '%T@\t%p\n' 2>/dev/null \
      | awk -F '\t' -v created="$created" '
          NF >= 2 {
            d = $1 - created
            if (d < 0) d = -d
            if (d <= 1800) print d "\t" $2
          }
        ' \
      | sort -n \
      | head -20 \
      | while IFS=$'\t' read -r _diff file; do
          [[ -f "$file" ]] || continue
          head -1 "$file" 2>/dev/null | jq -r \
            --arg cwd "$cwd" \
            --arg physical_cwd "$physical_cwd" '
              select(.type == "session_meta") |
              .payload as $p |
              select($p.cwd == $cwd or $p.cwd == $physical_cwd) |
              $p.id
            ' 2>/dev/null
        done \
      | head -1
  )"
  if [[ -n "$result" ]]; then
    print -r -- "$result"
    return
  fi

  history="$codex_home/history.jsonl"
  [[ -f "$history" ]] || return 1
  tail -2000 "$history" 2>/dev/null \
    | jq -r --argjson created "$created" '
        select((.session_id // "") != "" and (.ts // 0) > 0) |
        [(((.ts // 0) - $created) | if . < 0 then -. else . end), .session_id] | @tsv
      ' 2>/dev/null \
    | sort -n \
    | awk -F '\t' 'NR == 1 && $1 <= 14400 { print $2 }'
}

agent_tmux_infer_claude_session_id() {
  local program="$1" created="$2" cwd="$3"
  local claude_config_dir history physical_cwd created_ms
  claude_config_dir="$(agent_tmux_claude_config_dir "$program")" || return 1
  history="$claude_config_dir/history.jsonl"
  [[ -f "$history" && "$created" == <-> ]] || return 1
  physical_cwd="$(agent_tmux_physical_path "$cwd")"
  created_ms=$(( created * 1000 ))

  tail -1000 "$history" 2>/dev/null \
    | jq -r \
      --arg cwd "$cwd" \
      --arg physical_cwd "$physical_cwd" \
      --argjson created_ms "$created_ms" '
        select((.project == $cwd or .project == $physical_cwd) and (.timestamp // 0) >= ($created_ms - 120000)) |
        [(((.timestamp // 0) - $created_ms) | if . < 0 then -. else . end), .sessionId] | @tsv
      ' 2>/dev/null \
    | sort -n \
    | head -1 \
    | cut -f2
}

agent_tmux_resume_id() {
  local program="$1" created="$2" cwd="$3"
  case "$program" in
    codex|codex2|codex3|codexl) agent_tmux_infer_codex_session_id "$program" "$created" "$cwd" ;;
    claude|claude2|claudel|claudelp) agent_tmux_infer_claude_session_id "$program" "$created" "$cwd" ;;
    *)            return 1 ;;
  esac
}

agent_tmux_resume_command() {
  local program="$1" resume_id="${2:-}"
  case "$program" in
    codex)
      if [[ -n "$resume_id" ]]; then
        print -r -- "codex resume $resume_id"
      else
        print -r -- "codex resume"
      fi
      ;;
    codex2)
      if [[ -n "$resume_id" ]]; then
        print -r -- "codex2 resume $resume_id"
      else
        print -r -- "codex2 resume"
      fi
      ;;
    codex3)
      if [[ -n "$resume_id" ]]; then
        print -r -- "codex3 resume $resume_id"
      else
        print -r -- "codex3 resume"
      fi
      ;;
    codexl)
      if [[ -n "$resume_id" ]]; then
        print -r -- "codexl resume $resume_id"
      else
        print -r -- "codexl resume"
      fi
      ;;
    claude)
      if [[ -n "$resume_id" ]]; then
        print -r -- "claude --resume $resume_id"
      else
        print -r -- "claude --resume"
      fi
      ;;
    claude2)
      if [[ -n "$resume_id" ]]; then
        print -r -- "claude2 --resume $resume_id"
      else
        print -r -- "claude2 --resume"
      fi
      ;;
    claudel)
      if [[ -n "$resume_id" ]]; then
        print -r -- "claudel --resume $resume_id"
      else
        print -r -- "claudel --resume"
      fi
      ;;
    claudelp)
      if [[ -n "$resume_id" ]]; then
        print -r -- "claudelp --resume $resume_id"
      else
        print -r -- "claudelp --resume"
      fi
      ;;
    *) return 1 ;;
  esac
}

agent_tmux_live_json() {
  local sep=$'\037'
  local session title user_named created fields cwd physical_cwd program stamp lookup_created stamp_epoch resume_id resume_command now
  now="$(date +%s)"

  {
    while IFS="$sep" read -r session title user_named created; do
      [[ -n "$user_named" ]] && title="$user_named"
      fields="$(agent_tmux_session_fields "$session" "$title" "$created" 2>/dev/null)" || continue
      session="${fields%%$'\t'*}"
      fields="${fields#*$'\t'}"
      title="${fields%%$'\t'*}"
      fields="${fields#*$'\t'}"
      created="${fields%%$'\t'*}"
      fields="${fields#*$'\t'}"
      program="${fields%%$'\t'*}"
      stamp="${fields#*$'\t'}"
      cwd="$(tmux list-panes -t "=$session" -F '#{pane_current_path}' 2>/dev/null | head -1)"
      [[ -n "$cwd" ]] || cwd="$PWD"
      physical_cwd="$(agent_tmux_physical_path "$cwd")"
      lookup_created="$created"
      stamp_epoch="$(agent_tmux_stamp_epoch "$stamp" 2>/dev/null || true)"
      [[ -n "$stamp_epoch" ]] && lookup_created="$stamp_epoch"
      resume_id="$(tmux show-option -qv -t "=$session" @agent_glue_thread_id 2>/dev/null || true)"
      [[ -n "$resume_id" ]] || resume_id="$(agent_tmux_resume_id "$program" "$lookup_created" "$cwd" 2>/dev/null || true)"
      resume_command="$(agent_tmux_resume_command "$program" "$resume_id" 2>/dev/null || true)"
      jq -nc \
        --arg session "$session" \
        --arg title "$title" \
        --arg user_named "$user_named" \
        --arg program "$program" \
        --arg stamp "$stamp" \
        --arg cwd "$physical_cwd" \
        --arg resume_id "$resume_id" \
        --arg resume_command "$resume_command" \
        --argjson created "$created" \
        --argjson started "$lookup_created" \
        --argjson updated "$now" \
        '{
          session: $session,
          title: $title,
          user_named: $user_named,
          program: $program,
          stamp: $stamp,
          created: $created,
          started: $started,
          updated: $updated,
          cwd: $cwd,
          live: true,
          resume_id: $resume_id,
          resume_command: $resume_command
        }'
    done < <(tmux list-sessions -F $'#{session_name}\037#{@title}\037#{@agent_user_named}\037#{session_created}' 2>/dev/null)
  } | jq -s '.'
}

agent_tmux_update_recent() {
  local live_json="$1"
  local existing_json='[]'
  local tmp
  agent_tmux_ensure_state_dir
  if [[ -s "$agent_tmux_recent_file" ]]; then
    existing_json="$(cat "$agent_tmux_recent_file" 2>/dev/null || print -r -- '[]')"
  fi
  tmp="$agent_tmux_recent_file.$$"
  jq -n \
    --argjson existing "$existing_json" \
    --argjson live "$live_json" '
      def item_key:
        .program + "\u0001" + (if (.stamp // "") != "" then .stamp else .session end);
      def latest_nonempty($field):
        map(select((.[$field] // "") != ""))
        | sort_by(.updated // .created // 0)
        | .[-1][$field] // "";
      def merge_group:
        (sort_by(.updated // .created // 0) | .[-1]) as $latest
        | (latest_nonempty("resume_id")) as $resume_id
        | (latest_nonempty("resume_command")) as $resume_command
        | $latest
        | .resume_id = (if (.resume_id // "") != "" then .resume_id else $resume_id end)
        | .resume_command = (if (.resume_command // "") != "" then .resume_command else $resume_command end);
      (($existing | map(.live = false)) + $live)
      | map(select((.program // "") != "" and (.session // "") != ""))
      | sort_by(item_key)
      | group_by(item_key)
      | map(merge_group)
      | sort_by(.updated // .created // 0)
      | reverse
      | .[:100]
    ' > "$tmp" && mv "$tmp" "$agent_tmux_recent_file"
}

agent_tmux_recent_json() {
  local workspace="$1"
  local physical_workspace
  physical_workspace="$(agent_tmux_physical_path "$workspace")"
  if [[ ! -s "$agent_tmux_recent_file" ]]; then
    print -r -- '[]'
    return
  fi
  jq \
    --arg workspace "$physical_workspace" '
      map(select((.cwd // "") == $workspace))
    ' "$agent_tmux_recent_file" 2>/dev/null || print -r -- '[]'
}

agent_tmux_log_event() {
  local action="$1" session="$2" title="$3" program="$4" created="$5" cwd="$6" command_text="${7:-}" old_session="${8:-}"
  local physical_cwd now resume_id resume_command stamp stamp_epoch lookup_created
  command -v jq >/dev/null 2>&1 || return 0
  agent_tmux_ensure_state_dir
  [[ "$created" == <-> ]] || created=0
  physical_cwd="$(agent_tmux_physical_path "$cwd")"
  lookup_created="$created"
  stamp="$(agent_tmux_stamp_from_session "$session" 2>/dev/null || true)"
  stamp_epoch="$(agent_tmux_stamp_epoch "$stamp" 2>/dev/null || true)"
  [[ -n "$stamp_epoch" ]] && lookup_created="$stamp_epoch"
  now="$(date +%s)"
  resume_id="$(agent_tmux_resume_id "$program" "$lookup_created" "$physical_cwd" 2>/dev/null || true)"
  resume_command="$(agent_tmux_resume_command "$program" "$resume_id" 2>/dev/null || true)"
  jq -nc \
    --arg action "$action" \
    --arg session "$session" \
    --arg old_session "$old_session" \
    --arg title "$title" \
    --arg program "$program" \
    --arg cwd "$physical_cwd" \
    --arg command "$command_text" \
    --arg resume_id "$resume_id" \
    --arg resume_command "$resume_command" \
    --argjson ts "$now" \
    --argjson created "$created" \
    --argjson started "$lookup_created" \
    '{
      ts: $ts,
      action: $action,
      program: $program,
      title: $title,
      session: $session,
      old_session: (if $old_session == "" then null else $old_session end),
      created: $created,
      started: $started,
      cwd: $cwd,
      command: $command,
      resume_id: $resume_id,
      resume_command: $resume_command
    }' >> "$agent_tmux_events_file"
}

agent_tmux_print_recent() {
  local workspace="${1:-}"
  local json
  if [[ -n "$workspace" ]]; then
    json="$(agent_tmux_recent_json "$workspace")"
  elif [[ -s "$agent_tmux_recent_file" ]]; then
    json="$(cat "$agent_tmux_recent_file")"
  else
    json='[]'
  fi
  print -r -- "$json" | jq -r '
    (["when", "state", "program", "name", "tmux", "resume"] | @tsv),
    (.[] | [
      ((.updated // .created // 0) | strftime("%Y-%m-%d %H:%M:%S")),
      (if .live then "live" else "recent" end),
      .program,
      .title,
      .session,
      (.resume_command // "")
    ] | @tsv)
  ' | column -t -s $'\t'
}

case "${1:-}" in
  live-json)
    agent_tmux_live_json
    ;;
  recent-json)
    agent_tmux_recent_json "${2:-$PWD}"
    ;;
  update-recent)
    agent_tmux_update_recent "$(cat)"
    ;;
  log)
    shift
    agent_tmux_log_event "$@"
    ;;
  list)
    agent_tmux_print_recent "${2:-}"
    ;;
esac
