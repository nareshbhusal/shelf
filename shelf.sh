#!/usr/bin/env bash
# Shelf launcher. Uses plain `docker` only (no compose plugin needed).
#
#   ./shelf.sh start ~/Documents/Books         build, (re)start in Docker, remember the folder
#   ./shelf.sh start                           same, with what it remembered
#   ./shelf.sh stop | restart | logs | status
#   ./shelf.sh clean                           remove leftover old images (never your data)
#
# Several libraries at once: give each its own --name. Everything is remembered per name.
#   ./shelf.sh start ~/mounted/books --name private --data ~/mounted/shelf-data \
#                    --require-mount ~/mounted --port 4322
#   ./shelf.sh stop --name private             (also: restart, logs, status, backup, opener)
#   ./shelf.sh list                            every instance and whether it runs
#
# Other options for start:
#   --readonly            Shelf may never write to your books (no saving of highlights/notes)
#   --require-mount DIR   refuse to start (and create nothing) unless DIR is a mounted drive;
#                         repeatable. Also stops Docker from auto-restarting it after a reboot.
#   --port N              default 4321, or the next free port for extra instances
#   --data DIR            where this instance keeps its database + covers
#
# Data and safety:
#   ./shelf.sh backup [FILE] [--name N]        consistent copy of tags/lists/progress (instance must run)
#   ./shelf.sh restore FILE [--name N]         put a backup back (instance must be stopped)
#   ./shelf.sh opener [--name N]               (re)start the helper that lets "Open with" start programs
#                                              on your desktop (start does this for you)
#   ./shelf.sh native [FOLDER] [options]       run WITHOUT Docker (Node 22.13+); same options
#
# Shelf files: one small JSON file that says where a library and its data live. Nothing is
# remembered anywhere else (no ~/.config entry), so an encrypted library can carry its own.
#   ./shelf.sh init ~/mounted/shelf.json --library ~/mounted/books [--data DIR] [--port N] [--name TEXT] [--host ADDR] [--passkey KEY]
#                                              [--readonly] [--require-mount ~/mounted] [--ignore FOLDER]...
#   ./shelf.sh check ~/mounted/shelf.json      checks the pieces (folders, mounts, data matches library, port)
#   ./shelf.sh native ~/mounted/shelf.json     checks, then runs. Paths in the file may be absolute, ~/ or
#                                              relative to the file. (Native only for now, not Docker.)
#
# Environment: SHELF_PORT, SHELF_DATA set defaults for the first instance.
set -euo pipefail
ORIG_PWD="$PWD"
cd "$(dirname "$(readlink -f "$0")")"
SHELF_DIR="$PWD"

IMAGE=shelf:latest
CONF_DIR="$HOME/.config/shelf"

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
expand() { local p="$1"; p="${p/#\~/$HOME}"; printf '%s' "$p"; }
abspath() { local p; p="$(expand "$1")"; case "$p" in /*) printf '%s' "$p" ;; *) printf '%s/%s' "$ORIG_PWD" "$p" ;; esac; }

# ----------------------------------------------------------------------------- docker
D=()
need_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed. On Ubuntu:  sudo apt install docker.io   (then log out and in again)"
  if docker info >/dev/null 2>&1; then
    D=(docker)
  elif sudo docker info >/dev/null 2>&1; then
    D=(sudo docker)
    say "(using sudo for docker. To avoid this: sudo usermod -aG docker \$USER, then log out and in.)"
  else
    die "can't talk to the docker daemon. Is it running?  sudo systemctl start docker"
  fi
}

# ----------------------------------------------------------------------------- one instance
NAME=shelf
LIB="" DATA="" PORT="" MODE=rw
MOUNTS=()
POS=()

conf_file() { printf '%s/%s.conf' "$CONF_DIR" "$NAME"; }
container() { if [ "$NAME" = shelf ]; then printf 'shelf'; else printf 'shelf-%s' "$NAME"; fi; }
valid_name() { [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{0,30}$ ]]; }

# Reads the options shared by the commands. Anything else is a positional argument (POS).
parse() {
  local args=("$@") i=0 o_lib="" o_port="" o_data="" o_mode="" o_mounts=()
  POS=()
  while [ $i -lt ${#args[@]} ]; do
    case "${args[$i]}" in
      --name)          i=$((i+1)); NAME="${args[$i]:-}" ;;
      --port)          i=$((i+1)); o_port="${args[$i]:-}" ;;
      --data)          i=$((i+1)); o_data="${args[$i]:-}" ;;
      --require-mount) i=$((i+1)); o_mounts+=("${args[$i]:-}") ;;
      --readonly|--read-only) o_mode=ro ;;
      -*) die "unknown option: ${args[$i]}" ;;
      *)  POS+=("${args[$i]}") ;;
    esac
    i=$((i+1))
  done
  valid_name "$NAME" || die "instance names are lowercase letters, digits, - and _ (got '$NAME')"

  # what we remembered for this name ...
  local C_LIB="" C_DATA="" C_PORT="" C_MODE="" C_MOUNTS=""
  if [ -f "$(conf_file)" ]; then . "$(conf_file)"; fi
  LIB="$C_LIB"; DATA="$C_DATA"; PORT="$C_PORT"; MODE="${C_MODE:-rw}"
  MOUNTS=(); if [ -n "$C_MOUNTS" ]; then while IFS= read -r m; do [ -n "$m" ] && MOUNTS+=("$m"); done <<<"$C_MOUNTS"; fi

  # ... overridden by what was typed now
  [ ${#POS[@]} -gt 0 ] && LIB="${POS[0]}"
  [ -n "$o_port" ] && PORT="$o_port"
  [ -n "$o_data" ] && DATA="$o_data"
  [ -n "$o_mode" ] && MODE="$o_mode"
  [ ${#o_mounts[@]} -gt 0 ] && MOUNTS=("${o_mounts[@]}")

  # defaults for what is still empty
  if [ -z "$DATA" ]; then
    if [ "$NAME" = shelf ]; then DATA="${SHELF_DATA:-$HOME/.local/share/shelf}"; else DATA="$HOME/.local/share/shelf-$NAME"; fi
  fi
  DATA="$(expand "$DATA")"
  if [ -z "$LIB" ] && [ -f "$DATA/.library-path" ]; then LIB="$(cat "$DATA/.library-path")"; fi  # older versions
  [ -n "$LIB" ] && LIB="$(expand "$LIB")"
  if [ -z "$PORT" ]; then
    if [ "$NAME" = shelf ]; then PORT="${SHELF_PORT:-4321}"; else PORT="$(free_port)"; fi
  fi
  [[ "$PORT" =~ ^[0-9]+$ ]] || die "port must be a number"
  local k; for k in "${!MOUNTS[@]}"; do MOUNTS[$k]="$(expand "${MOUNTS[$k]}")"; done
}

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
free_port() {
  local p=4322 used=" "
  if [ -d "$CONF_DIR" ]; then used=" $(grep -h '^C_PORT=' "$CONF_DIR"/*.conf 2>/dev/null | cut -d= -f2 | tr '\n' ' ') "; fi
  while [[ "$used" == *" $p "* ]] || port_in_use "$p"; do p=$((p+1)); done
  printf '%s' "$p"
}

save_conf() {
  mkdir -p "$CONF_DIR"
  {
    printf 'C_LIB=%q\nC_DATA=%q\nC_PORT=%q\nC_MODE=%q\n' "$LIB" "$DATA" "$PORT" "$MODE"
    local m joined=""; for m in "${MOUNTS[@]+"${MOUNTS[@]}"}"; do joined+="$m"$'\n'; done
    printf 'C_MOUNTS=%q\n' "$joined"
  } > "$(conf_file)"
}

# Refuses (before anything is created) when a drive that should be mounted isn't.
check_mounts() {
  local m
  for m in "${MOUNTS[@]+"${MOUNTS[@]}"}"; do
    mountpoint -q "$m" 2>/dev/null || die "$m is not mounted (is the encrypted drive unlocked?). Nothing was started and nothing was created."
  done
}

check_dirs() {
  [ -d "$LIB" ] || die "not a folder: $LIB"
  LIB="$(readlink -f "$LIB")"
  if [ ! -d "$DATA" ]; then
    # Never invent parent folders for a custom data folder: if it sits on a drive that isn't mounted,
    # silently creating it would put your database on the wrong disk.
    if [ "$DATA" = "$HOME/.local/share/shelf" ] || [ "$DATA" = "$HOME/.local/share/shelf-$NAME" ]; then mkdir -p "$DATA"
    else mkdir "$DATA" 2>/dev/null || die "can't create $DATA (does its parent folder exist? is the drive mounted?)"; fi
  fi
  DATA="$(readlink -f "$DATA")"
}

container_exists()  { "${D[@]}" container inspect "$(container)" >/dev/null 2>&1; }
container_running() { [ "$("${D[@]}" container inspect -f '{{.State.Running}}' "$(container)" 2>/dev/null || true)" = "true" ]; }

# ----------------------------------------------------------------------------- desktop helper
# A container can't open windows on your desktop. This tiny helper runs on your computer as you and
# starts the programs you saved under Settings > Programs on Shelf's behalf (details: tools/shelf-opener.py).
run_dir() { printf '%s/shelf-opener-%s' "${XDG_RUNTIME_DIR:-/tmp/shelf-run-$(id -u)}" "$NAME"; }
stop_opener() {
  local pidf; pidf="$(run_dir)/pid"
  if [ -f "$pidf" ]; then kill "$(cat "$pidf")" 2>/dev/null || true; rm -f "$pidf"; fi
}
start_opener() {
  if ! command -v python3 >/dev/null 2>&1; then say "(python3 not found: \"Open with\" won't work. sudo apt install python3)"; return 0; fi
  local dir; dir="$(run_dir)"
  stop_opener
  mkdir -p "$dir"; chmod 700 "$dir"
  setsid nohup python3 tools/shelf-opener.py "$dir/sock" >"$dir/log" 2>&1 < /dev/null &
  echo $! > "$dir/pid"
  for _ in $(seq 1 30); do [ -S "$dir/sock" ] && return 0; sleep 0.1; done
  say "(the desktop helper didn't start; see $dir/log)"
}

# ----------------------------------------------------------------------------- commands
cmd_start() {
  if find_shelf_file "$@" >/dev/null; then die "shelf files are native-only for now: ./shelf.sh native FILE (Docker support for them isn't built yet)"; fi
  parse "$@"
  [ -n "$LIB" ] || die "which folder holds your books?   ./shelf.sh start ~/Documents/Books"
  check_mounts
  check_dirs
  save_conf
  need_docker
  local c; c="$(container)"

  say "Building image (fast when nothing changed)..."
  "${D[@]}" build -t "$IMAGE" .
  if container_exists; then "${D[@]}" rm -f "$c" >/dev/null; fi

  start_opener
  local rd; rd="$(run_dir)"

  say "Starting '$NAME' on $LIB ..."
  # --user: files in the data folder belong to you, not root.
  # 127.0.0.1: reachable from this computer only (there is no login).
  # The library is mounted read-write because highlights and notes are saved INSIDE the PDF you annotate
  # (nothing else is ever written there). With --readonly it is mounted :ro instead.
  local mount="$LIB:/library" extra=() restart=unless-stopped
  if [ "$MODE" = ro ]; then mount="$LIB:/library:ro"; extra+=(-e SHELF_READONLY=1); fi
  # After a reboot a locked drive must not be re-created empty on the wrong disk: don't auto-restart then.
  if [ ${#MOUNTS[@]} -gt 0 ]; then restart=no; fi
  if [ -d "$rd" ]; then extra+=(-v "$rd:/opener" -e SHELF_OPENER_SOCKET=/opener/sock -e "SHELF_HOST_LIBRARY=$LIB"); fi
  "${D[@]}" run -d --name "$c" --label "shelf.instance=$NAME" --restart "$restart" --init \
    --user "$(id -u):$(id -g)" \
    -p "127.0.0.1:$PORT:4321" \
    -v "$mount" \
    -v "$DATA:/data" \
    "${extra[@]}" \
    "$IMAGE" >/dev/null

  for _ in $(seq 1 40); do
    if curl -fs "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1; then
      say ""
      say "Shelf '$NAME' is running:  http://localhost:$PORT"
      say "Books folder:   $LIB  ($([ "$MODE" = ro ] && echo 'read-only: no highlights/notes' || echo 'read-write: highlights/notes are saved into PDFs'))"
      say "Tags, lists:    $DATA"
      [ ${#MOUNTS[@]} -gt 0 ] && say "Requires mounts: ${MOUNTS[*]}  (stop it before locking the drive: ./shelf.sh stop --name $NAME)"
      return 0
    fi
    container_running || break
    sleep 0.5
  done
  say ""
  say "It did not come up. Last log lines:"
  "${D[@]}" logs --tail 30 "$c" || true
  say ""
  say "If your books are on an encrypted FUSE drive (gocryptfs, encfs, ...): Docker's daemon runs as root and"
  say "usually can't see a drive mounted by you. Mount it with the 'allow_other' option (and enable"
  say "user_allow_other in /etc/fuse.conf), or use ./shelf.sh native."
  exit 1
}

cmd_stop() {
  parse "$@"; need_docker
  stop_opener
  if container_exists; then "${D[@]}" stop "$(container)" >/dev/null && say "Stopped '$NAME'."; else say "'$NAME' isn't running."; fi
}

cmd_restart() {
  parse "$@"; need_docker
  container_exists || die "nothing to restart. Use: ./shelf.sh start --name $NAME"
  check_mounts
  start_opener
  "${D[@]}" restart "$(container)" >/dev/null && say "Restarted '$NAME'."
}

cmd_logs() { parse "$@"; need_docker; container_exists || die "no such instance yet"; "${D[@]}" logs -f --tail 100 "$(container)"; }

cmd_status() {
  parse "$@"; need_docker
  if container_running; then say "'$NAME' running: http://localhost:$PORT   books: ${LIB:-?}   data: $DATA"
  elif container_exists; then say "'$NAME' is stopped. Start it with: ./shelf.sh start --name $NAME"
  else say "'$NAME' hasn't been created. Run: ./shelf.sh start ~/path/to/books --name $NAME"; fi
}

cmd_list() {
  need_docker
  [ -d "$CONF_DIR" ] && ls "$CONF_DIR"/*.conf >/dev/null 2>&1 || { say "No instances yet."; return 0; }
  local f
  for f in "$CONF_DIR"/*.conf; do
    NAME="$(basename "$f" .conf)"
    parse
    local st="not created"
    if container_running; then st="running"; elif container_exists; then st="stopped"; fi
    printf '%-14s %-10s http://localhost:%-6s books: %s   data: %s\n' "$NAME" "$st" "$PORT" "$LIB" "$DATA"
  done
}

cmd_opener() { parse "$@"; start_opener; say "Desktop helper for '$NAME' is running. Retry \"Open with\"."; }

cmd_backup() {
  parse "$@"
  local day out; day="$(date +%F)"
  out="${POS[0]:-$ORIG_PWD/shelf-$NAME-backup-$day.db}"
  curl -fsS "http://127.0.0.1:$PORT/api/backup" -o "$out" || die "couldn't reach '$NAME' on port $PORT. Is it running? (./shelf.sh status --name $NAME)"
  say "Saved $out"
  say "Highlights and notes are inside the PDFs; back those up with your books."
}

cmd_restore() {
  POS=(); parse "$@"
  [ ${#POS[@]} -gt 0 ] || die "usage: ./shelf.sh restore BACKUP_FILE [--name N]"
  local file; file="$(expand "${POS[0]}")"
  [ -f "$file" ] || die "no such file: $file"
  head -c 15 "$file" | grep -q 'SQLite format 3' || die "$file is not a Shelf backup (not an SQLite database)"
  [ -d "$DATA" ] || die "no data folder at $DATA"
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    D=(docker)
    if container_running; then die "'$NAME' is running; stop it first: ./shelf.sh stop --name $NAME"; fi
  fi
  if [ -f "$DATA/shelf.db" ]; then cp "$DATA/shelf.db" "$DATA/shelf.db.before-restore-$(date +%s)"; fi
  rm -f "$DATA/shelf.db-wal" "$DATA/shelf.db-shm"
  cp "$file" "$DATA/shelf.db"
  say "Restored. Start it again: ./shelf.sh start --name $NAME"
  say "On the first scan, books are matched by content, so tags/lists/progress reattach even if you moved files."
}

need_node() {
  command -v node >/dev/null 2>&1 || die "node is not installed (Shelf needs Node 22.13 or newer: https://nodejs.org or nvm)"
  node -e "require('node:sqlite')" >/dev/null 2>&1 || die "this Node ($(node -v)) has no built-in SQLite; Shelf needs 22.13 or newer (try: nvm install 22)"
  if [ ! -d node_modules ]; then say "Installing dependencies (once)..."; npm ci --omit=dev; fi
}

# The first argument that is an existing file (a shelf file), if any.
find_shelf_file() { local a; for a in "$@"; do case "$a" in -*) ;; *) if [ -f "$(abspath "$a")" ]; then printf '%s' "$(abspath "$a")"; return 0; fi ;; esac; done; return 1; }

cmd_check() { [ $# -ge 1 ] || die "usage: ./shelf.sh check SHELF_FILE"; need_node; exec node_modules/.bin/tsx src/shelfcli.ts check "$(abspath "$1")"; }

cmd_init() {
  [ $# -ge 1 ] || die "usage: ./shelf.sh init SHELF_FILE --library DIR [--data DIR] [--port N] [--name TEXT] [--host ADDR] [--passkey KEY] [--readonly] [--require-mount DIR] [--ignore FOLDER]..."
  need_node
  local f; f="$(abspath "$1")"; shift
  (cd "$ORIG_PWD" && exec "$SHELF_DIR/node_modules/.bin/tsx" "$SHELF_DIR/src/shelfcli.ts" init "$f" "$@")
}

# Runs from a shelf file: checks everything first, creates nothing outside what the file names.
cmd_native_file() {
  local f="$1"; shift
  [ $# -eq 0 ] || die "options can't be combined with a shelf file; put them in the file ($f)"
  need_node
  node_modules/.bin/tsx src/shelfcli.ts check "$f" || die "the shelf file didn't check out. Nothing was started."
  command -v pdfinfo >/dev/null 2>&1 || say "(tip: sudo apt install poppler-utils  gives PDFs their titles, page counts and covers)"
  say "Starting from $f   (Ctrl+C to stop)"
  exec env SHELF_FILE="$f" SHELF_DOCKER=0 node_modules/.bin/tsx src/server.ts
}

# Runs Shelf directly on this computer (no Docker).
cmd_native() {
  local sf; if sf="$(find_shelf_file "$@")"; then
    local rest=() a; for a in "$@"; do [ "$(abspath "$a")" = "$sf" ] || rest+=("$a"); done
    cmd_native_file "$sf" "${rest[@]+"${rest[@]}"}"
  fi
  parse "$@"
  [ -n "$LIB" ] || die "which folder holds your books?   ./shelf.sh native ~/Documents/Books"
  command -v node >/dev/null 2>&1 || die "node is not installed (Shelf needs Node 22.13 or newer: https://nodejs.org or nvm)"
  node -e "require('node:sqlite')" >/dev/null 2>&1 || die "this Node ($(node -v)) has no built-in SQLite; Shelf needs 22.13 or newer (try: nvm install 22)"
  check_mounts
  check_dirs
  save_conf
  command -v pdfinfo >/dev/null 2>&1 || say "(tip: sudo apt install poppler-utils  gives PDFs their titles, page counts and covers)"
  if [ ! -d node_modules ]; then say "Installing dependencies (once)..."; npm ci --omit=dev; fi
  local ro=0; [ "$MODE" = ro ] && ro=1
  say "Shelf '$NAME' on $LIB  ->  http://localhost:$PORT   (Ctrl+C to stop)"
  LIBRARY_DIR="$LIB" DATA_DIR="$DATA" PORT="$PORT" SHELF_DOCKER=0 SHELF_READONLY="$ro" exec node_modules/.bin/tsx src/server.ts
}

cmd_forget() { parse "$@"; rm -f "$(conf_file)"; say "Forgot the saved settings for '$NAME' (its data folder $DATA is untouched)."; }

# Old image versions pile up as untagged ("dangling") images after rebuilds. Remove them. Never touches data.
cmd_clean() { need_docker; "${D[@]}" image prune -f; }

cmd="${1:-help}"; [ $# -gt 0 ] && shift
case "$cmd" in
  start)   cmd_start "$@" ;;
  stop)    cmd_stop "$@" ;;
  restart) cmd_restart "$@" ;;
  logs)    cmd_logs "$@" ;;
  status)  cmd_status "$@" ;;
  list)    cmd_list ;;
  opener)  cmd_opener "$@" ;;
  backup)  cmd_backup "$@" ;;
  restore) cmd_restore "$@" ;;
  native)  cmd_native "$@" ;;
  check)   cmd_check "$@" ;;
  init)    cmd_init "$@" ;;
  forget)  cmd_forget "$@" ;;
  clean)   cmd_clean ;;
  *)       sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
