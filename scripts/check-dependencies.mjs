import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const postinstall = args.has("--postinstall");

const keySenders = ["ydotool", "wtype", "xdotool"];

function commandExists(command) {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function parseOsRelease() {
  try {
    return Object.fromEntries(
      readFileSync("/etc/os-release", "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const [key, ...valueParts] = line.split("=");
          return [key, valueParts.join("=").replace(/^"|"$/g, "")];
        }),
    );
  } catch {
    return {};
  }
}

function installCommand() {
  const osRelease = parseOsRelease();
  const id = `${osRelease.ID || ""} ${osRelease.ID_LIKE || ""}`.toLowerCase();

  if (id.includes("fedora") || id.includes("rhel")) {
    return "sudo dnf -y install ydotool && sudo systemctl enable --now ydotool.service";
  }

  if (id.includes("debian") || id.includes("ubuntu")) {
    return "sudo apt-get update && sudo apt-get install -y ydotool && sudo systemctl enable --now ydotool.service";
  }

  if (id.includes("arch")) {
    return "sudo pacman -S --needed ydotool && sudo systemctl enable --now ydotool.service";
  }

  return "Install ydotool with your system package manager, then enable and start ydotool.service.";
}

function ydotoolSocketPath() {
  const candidates = [
    process.env.YDOTOOL_SOCKET,
    "/run/ydotool/socket",
    process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, ".ydotool_socket") : undefined,
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate));
}

function warpDatabasePath() {
  return path.join(homedir(), ".local/state/warp-terminal/warp.sqlite");
}

const hasPython = commandExists("python3");
const availableKeySenders = keySenders.filter(commandExists);
const dbPath = warpDatabasePath();
const hasWarpDatabase = existsSync(dbPath);
const ydotoolSocket = ydotoolSocketPath();
const readyKeySenders = availableKeySenders.filter((sender) => sender !== "ydotool" || ydotoolSocket);
const hasKeySender = availableKeySenders.length > 0;
const hasReadyKeySender = readyKeySenders.length > 0;

const lines = [
  "Warp Tabs dependency check",
  `python3: ${hasPython ? "found" : "missing"}`,
  `key sender: ${hasKeySender ? availableKeySenders.join(", ") : "missing"}`,
  `Warp database: ${hasWarpDatabase ? dbPath : "not found yet"}`,
];

if (availableKeySenders.includes("ydotool")) {
  lines.push(`ydotool socket: ${ydotoolSocket || "not found"}`);
}

if (!hasKeySender) {
  lines.push("");
  lines.push("Existing-tab switching needs one key sender. On GNOME Wayland, ydotool is recommended.");
  lines.push(`Install command: ${installCommand()}`);
  lines.push("Or run: npm run setup:system");
}

if (hasKeySender && !hasReadyKeySender) {
  lines.push("");
  lines.push("ydotool is installed, but its daemon socket was not found.");
  lines.push("Start the daemon with: sudo systemctl enable --now ydotool.service");
}

if (!hasPython) {
  lines.push("");
  lines.push("python3 is required because the extension reads Warp's SQLite state using Python's bundled sqlite3 module.");
}

const failed = !hasPython || !hasReadyKeySender;

if (!postinstall || failed) {
  console.log(lines.join("\n"));
}

if (strict && failed) {
  process.exitCode = 1;
}
