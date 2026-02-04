#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${ROOT_DIR}/.netlify/dev.pid"
LOG_FILE="${ROOT_DIR}/.netlify/dev.log"
ENV_FILE="${ROOT_DIR}/.env"

ensure_netlify_dir() {
  mkdir -p "${ROOT_DIR}/.netlify"
}

load_env() {
  if [[ -f "${ENV_FILE}" ]]; then
    # shellcheck disable=SC1090
    set -a
    source "${ENV_FILE}"
    set +a
  else
    echo "Missing .env at ${ENV_FILE}"
    echo "Create it with NETLIFY_DATABASE_URL and DANCES_SQL."
    exit 1
  fi
}

start() {
  ensure_netlify_dir
  if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    echo "Already running (pid $(cat "${PID_FILE}"))."
    exit 0
  fi
  load_env
  local mode="${1:-remote}"
  if [[ "${mode}" != "remote" && "${mode}" != "local" ]]; then
    echo "Invalid mode: ${mode} (use remote or local)"
    exit 1
  fi
  echo "{\"mode\":\"${mode}\"}" > "${ROOT_DIR}/data-mode.json"
  echo "Starting Netlify Dev..."
  nohup npx netlify dev > "${LOG_FILE}" 2>&1 &
  echo $! > "${PID_FILE}"
  echo "Started (pid $(cat "${PID_FILE}")). Mode: ${mode}. Log: ${LOG_FILE}"
}

stop() {
  if [[ -f "${PID_FILE}" ]]; then
    PID="$(cat "${PID_FILE}")"
    if kill -0 "${PID}" 2>/dev/null; then
      echo "Stopping (pid ${PID})..."
      kill "${PID}"
      rm -f "${PID_FILE}"
      echo "Stopped."
      exit 0
    fi
    rm -f "${PID_FILE}"
  fi
  echo "Not running."
}

status() {
  if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    echo "Running (pid $(cat "${PID_FILE}"))."
  else
    echo "Not running."
  fi
}

case "${1:-}" in
  start) start "${2:-remote}" ;;
  stop) stop ;;
  status) status ;;
  *)
    echo "Usage: ./dev.sh start [remote|local] | stop | status"
    exit 1
    ;;
esac
