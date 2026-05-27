#!/usr/bin/env bash
set -euo pipefail

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
else
  ID=""
  ID_LIKE=""
fi

os_id="${ID:-} ${ID_LIKE:-}"

enable_ydotool_service() {
  sudo systemctl enable --now ydotool.service || sudo systemctl enable --now ydotoold.service
}

case "$os_id" in
  *fedora*|*rhel*)
    sudo dnf -y install ydotool
    enable_ydotool_service
    ;;
  *debian*|*ubuntu*)
    sudo apt-get update
    sudo apt-get install -y ydotool
    enable_ydotool_service
    ;;
  *arch*)
    sudo pacman -S --needed ydotool
    enable_ydotool_service
    ;;
  *)
    echo "Unsupported distro for automatic setup."
    echo "Install ydotool with your package manager, then enable and start ydotool.service."
    exit 1
    ;;
esac

npm run doctor
