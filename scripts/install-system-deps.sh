#!/usr/bin/env bash
set -euo pipefail

assume_yes=false
skip_install=false

usage() {
  cat <<'EOF'
Usage: npm run doctor:fix -- [options]
       npm run setup:system -- [options]

Installs and enables system dependencies needed for Warp tab switching.

Options:
  --yes, -y       Pass non-interactive yes flags to package managers.
  --skip-install Only enable services and verify existing packages.
  --help, -h      Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)
      assume_yes=true
      shift
      ;;
    --skip-install)
      skip_install=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
else
  ID=""
  ID_LIKE=""
fi

os_id="${ID:-} ${ID_LIKE:-}"

log() {
  printf '\n==> %s\n' "$*"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

install_packages() {
  if [[ "$skip_install" == true ]]; then
    log "Skipping package installation"
    return
  fi

  log "Installing required packages"
  case "$os_id" in
    *fedora*|*rhel*)
      sudo dnf -y install python3 ydotool
      ;;
    *debian*|*ubuntu*)
      sudo apt-get update
      sudo apt-get install -y python3 ydotool
      ;;
    *arch*)
      if [[ "$assume_yes" == true ]]; then
        sudo pacman -S --needed --noconfirm python ydotool
      else
        sudo pacman -S --needed python ydotool
      fi
      ;;
    *)
      echo "Unsupported distro for automatic package installation: ${PRETTY_NAME:-unknown}."
      echo "Install python3 and ydotool with your package manager, then rerun with --skip-install."
      exit 1
      ;;
  esac
}

enable_ydotool_service() {
  if ! command_exists systemctl; then
    echo "systemctl was not found; start ydotoold manually for your init system."
    return 1
  fi

  log "Enabling ydotool daemon"
  local units=(ydotool.service ydotoold.service)
  local unit

  for unit in "${units[@]}"; do
    if sudo systemctl enable --now "$unit"; then
      echo "Enabled $unit"
      return 0
    fi
  done

  echo "Could not enable ydotool.service or ydotoold.service."
  echo "Check available units with: systemctl list-unit-files 'ydotool*'"
  return 1
}

ydotool_socket() {
  local candidates=(
    "${YDOTOOL_SOCKET:-}"
    "/run/ydotool/socket"
    "${XDG_RUNTIME_DIR:-}/.ydotool_socket"
    "/tmp/.ydotool_socket"
  )
  local candidate

  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" ]] || continue
    if [[ -e "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

verify_socket() {
  log "Verifying ydotool socket"

  local socket
  if ! socket="$(ydotool_socket)"; then
    echo "No ydotool socket found."
    return 1
  fi

  if [[ ! -r "$socket" || ! -w "$socket" ]]; then
    echo "Found ydotool socket, but it is not readable and writable by this user: $socket"
    echo "Inspect permissions with: ls -l $socket"
    return 1
  fi

  echo "ydotool socket ready: $socket"
}

install_packages

if command_exists ydotool; then
  if ! verify_socket; then
    enable_ydotool_service || true
    sleep 0.5
    verify_socket || true
  fi
else
  echo "ydotool is still not installed after setup."
fi

npm run doctor
