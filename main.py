"""
License Manager - One-Click Launcher

Run this file to manage the whole project from one place. It shows a short
numbered menu with three actions:

    1) Run      - start the complete project (Worker API + Admin console +
                  License Checker), wait until every URL really answers,
                  then open the admin console in your browser
    2) Build    - install dependencies, build every package, type-check and
                  run every test suite once, leaving a verified build
    3) Update   - fetch the latest code from YOUR configured Git URL
                  (not the original upstream), then reinstall + rebuild

Usage:
    python main.py                # Show the numbered menu
    python main.py --run          # 1) Run the complete project
    python main.py --build        # 2) Build + install + verify everything once
    python main.py --update       # 3) Update from your configured Git URL
    python main.py --reset-admin  # Reset the local login to admin / admin

Login for a fresh local setup: username "admin", password "admin".
You are forced to choose a new password on first login.

The update URL is never hardcoded. It is read from launcher.config.json
(key "update_url") or the LICENSE_MANAGER_UPDATE_URL environment variable; if
neither is set, option 3 asks for it once and saves it for next time.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORKER_DIR = ROOT / "worker"
ADMIN_DIR = ROOT / "admin"
DEV_VARS = WORKER_DIR / ".dev.vars"
DEV_VARS_EXAMPLE = WORKER_DIR / ".dev.vars.example"
CONFIG_FILE = ROOT / "launcher.config.json"

# Ports must match worker (wrangler dev default), admin/vite.config.ts and
# license-checker/vite.config.ts.
WORKER_PORT = 8787
ADMIN_PORT = 5175
CHECKER_PORT = 5176

# Default local login created/restored by scripts/reset-admin.mjs.
DEFAULT_USERNAME = "admin"
DEFAULT_PASSWORD = "admin"
# Global master password an admin must also supply at login (seeded by
# scripts/reset-admin.mjs). Normal users do not need it.
DEFAULT_MASTER_PASSWORD = "master"

IS_WINDOWS = os.name == "nt"

# Windows ships `pnpm` as a .CMD/.EXE shim; resolve it once so subprocess can
# launch it by full path on every platform.
PNPM = shutil.which("pnpm") or "pnpm"

# Environment for every child process.
#  - WRANGLER_HIDE_BANNER: wrangler's banner triggers an npm "update check".
#    When registry.npmjs.org is slow/unreachable (seen here over IPv6) that
#    socket never closes and keeps wrangler alive forever after its work is
#    done, so `db:migrate:local` / `build` never return. Hiding the banner
#    skips the update check entirely.
#  - WRANGLER_SEND_METRICS: no telemetry request on exit either.
CHILD_ENV = dict(os.environ)
CHILD_ENV["WRANGLER_HIDE_BANNER"] = "true"
CHILD_ENV["WRANGLER_SEND_METRICS"] = "false"


def log(msg: str = "") -> None:
    print(f"[launcher] {msg}", flush=True)


def enable_utf8_console() -> None:
    """Make wrangler's ✅ etc. render instead of mojibake on Windows consoles."""
    if not IS_WINDOWS:
        return
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
    except Exception:
        pass


# --------------------------------------------------------------------------
# Process helpers
# --------------------------------------------------------------------------

def _resolve(cmd):
    cmd = [str(c) for c in cmd]
    if cmd and cmd[0] == "pnpm":
        cmd = [PNPM] + cmd[1:]
    return cmd


def kill_tree(proc: subprocess.Popen) -> None:
    """Stop a process and everything it started (pnpm -> node -> workerd)."""
    if proc.poll() is not None:
        return
    if IS_WINDOWS:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def run(cmd, cwd=None, timeout=None):
    """Run a command that is expected to finish. Fails loudly on a non-zero
    exit, and kills the whole process tree if it exceeds `timeout` seconds
    instead of hanging forever."""
    cmd = _resolve(cmd)
    log("$ " + " ".join(cmd))
    proc = subprocess.Popen(cmd, cwd=cwd or ROOT, env=CHILD_ENV,
                            stdin=subprocess.DEVNULL)
    try:
        rc = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        raise RuntimeError(f"Command timed out after {timeout}s: {' '.join(cmd)}")
    except KeyboardInterrupt:
        kill_tree(proc)
        raise
    if rc != 0:
        raise subprocess.CalledProcessError(rc, cmd)


def start(cmd, cwd=None) -> subprocess.Popen:
    """Start a long-running command (dev server) and return immediately."""
    cmd = _resolve(cmd)
    log("$ " + " ".join(cmd) + "   (background)")
    return subprocess.Popen(cmd, cwd=cwd or ROOT, env=CHILD_ENV)


# --------------------------------------------------------------------------
# Network helpers
# --------------------------------------------------------------------------

def local_ip() -> str:
    """Best-effort LAN IPv4 of this machine. No packet is sent; the OS just
    reports which interface would route toward a public address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def http_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=3) as resp:
            return 200 <= resp.status < 500
    except urllib.error.HTTPError as exc:
        return exc.code < 500
    except (urllib.error.URLError, OSError, ValueError):
        return False


def stop_stale_project_servers(ports) -> None:
    """If a previous run of THIS project is still holding our ports (e.g. the
    terminal was closed without Ctrl+C), stop it. Processes that do not belong
    to this project are never touched; we report them instead."""
    busy = [p for p in ports if port_in_use(p)]
    if not busy:
        return
    if not IS_WINDOWS:
        raise RuntimeError(f"Port(s) {busy} already in use. Stop the other process and retry.")
    root = str(ROOT).replace("'", "''")
    port_list = ",".join(str(p) for p in busy)
    script = (
        f"$ports=@({port_list}); $root='{root}';"
        "foreach($p in $ports){"
        " $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;"
        " if(-not $c){continue};"
        " $proc = Get-CimInstance Win32_Process -Filter \"ProcessId=$($c.OwningProcess)\";"
        " $cmd = [string]$proc.CommandLine;"
        " if($cmd -like \"*$root*\" -or $cmd -match 'wrangler|workerd|vite'){"
        "  taskkill /PID $c.OwningProcess /T /F | Out-Null; Write-Output \"stopped:$p\" }"
        " else { Write-Output \"foreign:$p:$($proc.Name)\" } }"
    )
    out = subprocess.run(["powershell", "-NoProfile", "-Command", script],
                         capture_output=True, text=True).stdout
    for line in out.splitlines():
        if line.startswith("stopped:"):
            log(f"Stopped a leftover server from a previous run on port {line.split(':')[1]}.")
        elif line.startswith("foreign:"):
            _, port, name = line.split(":", 2)
            raise RuntimeError(f"Port {port} is used by another program ({name}). Close it and retry.")
    time.sleep(1)
    still = [p for p in busy if port_in_use(p)]
    if still:
        raise RuntimeError(f"Port(s) {still} are still busy. Close the program using them and retry.")


def wait_until_up(checks, timeout=180) -> None:
    """Poll each (name, url) until it answers or the timeout expires."""
    pending = dict(checks)
    deadline = time.time() + timeout
    while pending and time.time() < deadline:
        for name, url in list(pending.items()):
            if http_ok(url):
                log(f"{name} is up: {url}")
                del pending[name]
        if pending:
            time.sleep(2)
    if pending:
        raise RuntimeError("Did not start in time: " + ", ".join(pending))


# --------------------------------------------------------------------------
# Shared setup helpers
# --------------------------------------------------------------------------

def load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            log("Could not read launcher.config.json; treating it as empty.")
    return {}


def save_config(cfg: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")


def ensure_pnpm() -> None:
    global PNPM
    if shutil.which("pnpm") is None:
        log("pnpm not found. Installing it via npm...")
        subprocess.run(["npm", "install", "-g", "pnpm"], check=True, shell=IS_WINDOWS)
    PNPM = shutil.which("pnpm") or "pnpm"
    log("pnpm: " + str(PNPM))


def ensure_dev_vars() -> None:
    if DEV_VARS.exists():
        log("worker/.dev.vars found.")
        return
    # env:init generates real random secrets (incl. the Ed25519 signing key),
    # which the example file cannot provide.
    log("Generating local secrets (worker/.dev.vars)...")
    run(["pnpm", "env:init"], timeout=120)


def install_deps(force: bool = False) -> None:
    if (ROOT / "node_modules").exists() and not force:
        log("Dependencies already installed.")
        return
    log("Installing dependencies...")
    run(["pnpm", "install"], timeout=900)


def migrate_db() -> None:
    log("Applying local database migrations...")
    run(["pnpm", "db:migrate:local"], timeout=180)


def reset_admin_login() -> None:
    """Set the local login to admin/admin with a forced change on first use."""
    log("Resetting local login to admin / admin (must be changed after login)...")
    run(["node", "scripts/reset-admin.mjs", "--username", DEFAULT_USERNAME,
         "--password", DEFAULT_PASSWORD, "--allow-weak"], timeout=180)
    cfg = load_config()
    cfg["admin_initialized"] = True
    save_config(cfg)


def ensure_admin_login() -> None:
    """On the first launch only, make sure admin/admin works. Later launches
    never touch the password you chose."""
    if load_config().get("admin_initialized"):
        return
    reset_admin_login()


def ensure_master_password_env() -> None:
    """Make sure worker/.dev.vars carries ADMIN_MASTER_PASSWORD on every start.

    Runs OUTSIDE ensure_dev_vars()'s early-return so an existing .dev.vars that
    predates the master-password feature still gets the key appended once. The
    seed script is a no-op when the key is already present."""
    if not DEV_VARS.exists():
        return
    log("Ensuring ADMIN_MASTER_PASSWORD is set in worker/.dev.vars...")
    run(["node", "scripts/ensure-master-password-env.mjs"], timeout=60)


def common_setup(force_install: bool = False) -> None:
    ensure_pnpm()
    install_deps(force=force_install)
    ensure_dev_vars()
    ensure_master_password_env()
    migrate_db()
    ensure_admin_login()


def print_access_urls() -> None:
    ip = local_ip()
    log("=" * 60)
    log("  PROJECT IS LIVE")
    log("=" * 60)
    log(f"  Admin console : http://localhost:{ADMIN_PORT}")
    log(f"                  http://{ip}:{ADMIN_PORT}   (other devices on your Wi-Fi)")
    log(f"  License checker: http://localhost:{CHECKER_PORT}")
    log(f"                  http://{ip}:{CHECKER_PORT}")
    log(f"  Worker API    : http://localhost:{WORKER_PORT}/api/health")
    log(f"                  http://{ip}:{WORKER_PORT}/api/health")
    log("-" * 60)
    log("  Admin login (pick \"Admin\" in the login dropdown):")
    log(f"             username       : {DEFAULT_USERNAME}")
    log(f"             password       : {DEFAULT_PASSWORD}   (first login forces a change)")
    log(f"             master password: {DEFAULT_MASTER_PASSWORD}")
    log("  User login (pick \"User\" in the login dropdown):")
    log("             username + password only (no master password)")
    log("             Create users from Settings -> Users after signing in as admin.")
    log("             Forgot the admin login later?  python main.py --reset-admin")
    log(f"  In the checker, use server URL: http://localhost:{WORKER_PORT}")
    log(f"  This machine's LAN IP: {ip}")
    log("  (If another device can't connect, allow Node.js through Windows Firewall.)")
    log("=" * 60)
    log("Press Ctrl+C to stop everything.")


# --------------------------------------------------------------------------
# Option 1 - Run the complete project
# --------------------------------------------------------------------------

def action_run() -> None:
    stop_stale_project_servers([WORKER_PORT, ADMIN_PORT, CHECKER_PORT])
    common_setup()

    log("Starting Worker API + Admin console + License checker...")
    procs = [
        start(["pnpm", "dev"]),
        start(["pnpm", "--filter", "@license-manager/license-checker", "dev"]),
    ]
    try:
        wait_until_up([
            ("Worker API", f"http://127.0.0.1:{WORKER_PORT}/api/health"),
            ("Admin console", f"http://127.0.0.1:{ADMIN_PORT}/"),
            ("License checker", f"http://127.0.0.1:{CHECKER_PORT}/"),
        ])
        print_access_urls()
        if os.environ.get("LAUNCHER_NO_BROWSER") != "1":
            webbrowser.open(f"http://localhost:{ADMIN_PORT}")
        # Stay alive while the servers run; exit if any of them dies.
        while all(p.poll() is None for p in procs):
            time.sleep(1)
        log("A server stopped unexpectedly; shutting the rest down.")
    finally:
        for p in procs:
            kill_tree(p)


# --------------------------------------------------------------------------
# Option 2 - Build + install + verify the whole project once
# --------------------------------------------------------------------------

def action_build() -> None:
    stop_stale_project_servers([WORKER_PORT, ADMIN_PORT, CHECKER_PORT])
    common_setup(force_install=True)

    log("Building admin console + worker...")
    run(["pnpm", "build"], timeout=900)
    log("Building license checker...")
    run(["pnpm", "--filter", "@license-manager/license-checker", "build"], timeout=600)

    log("Type-checking all packages...")
    run(["pnpm", "type-check"], timeout=600)
    run(["pnpm", "--filter", "@license-manager/license-checker", "type-check"], timeout=300)

    log("Running every test suite...")
    run(["pnpm", "test"], timeout=1200)
    run(["pnpm", "--filter", "@license-manager/license-checker", "test"], timeout=600)

    log("=" * 60)
    log("  BUILD COMPLETE - installed, built, type-checked and tested.")
    log("  Start the website with:  python main.py --run   (or option 1)")
    log("=" * 60)


# --------------------------------------------------------------------------
# Option 3 - Update from YOUR configured Git URL
# --------------------------------------------------------------------------

def resolve_update_url() -> str:
    """URL from env, then config file, else ask once and save. The original
    upstream URL is never hardcoded."""
    env_url = os.environ.get("LICENSE_MANAGER_UPDATE_URL", "").strip()
    if env_url:
        return env_url
    cfg = load_config()
    url = str(cfg.get("update_url", "")).strip()
    if url:
        return url
    log("No update URL configured yet.")
    url = input("Enter YOUR Git repository URL to update from: ").strip()
    if not url:
        raise RuntimeError("An update URL is required for option 3.")
    cfg["update_url"] = url
    save_config(cfg)
    log(f"Saved update URL to {CONFIG_FILE.name}.")
    return url


def action_update() -> None:
    if shutil.which("git") is None:
        raise RuntimeError("git is not installed or not on PATH. Install git first.")

    url = resolve_update_url()
    log(f"Updating from your URL: {url}")

    if not (ROOT / ".git").exists():
        raise RuntimeError(
            "This folder is not a git checkout, so it can't be updated in place.\n"
            f"           Clone your repo instead:  git clone {url} license-manager")

    # A dedicated remote pointing at the user's URL; 'origin' is left alone.
    subprocess.run(["git", "remote", "remove", "launcher-update"], cwd=ROOT,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run(["git", "remote", "add", "launcher-update", url], timeout=30)
    run(["git", "fetch", "launcher-update"], timeout=300)

    branch = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=ROOT,
                            capture_output=True, text=True).stdout.strip() or "main"
    has_branch = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"refs/remotes/launcher-update/{branch}"],
        cwd=ROOT, stdout=subprocess.DEVNULL).returncode == 0
    if not has_branch:
        default = subprocess.run(
            ["git", "remote", "show", "launcher-update"], cwd=ROOT,
            capture_output=True, text=True).stdout
        head = next((l.split(":", 1)[1].strip() for l in default.splitlines()
                     if "HEAD branch" in l), "main")
        log(f"Your URL has no branch '{branch}'; using its default branch '{head}'.")
        branch_ref = f"launcher-update/{head}"
    else:
        branch_ref = f"launcher-update/{branch}"

    log(f"Fast-forwarding to {branch_ref} (your local work is never overwritten)...")
    merged = subprocess.run(["git", "merge", "--ff-only", branch_ref], cwd=ROOT)
    if merged.returncode != 0:
        raise RuntimeError(
            "Could not fast-forward: you have local changes or a diverged history.\n"
            "           Commit or stash your changes, then run Update again.")

    log("Reinstalling + rebuilding after the update...")
    common_setup(force_install=True)
    run(["pnpm", "build"], timeout=900)
    run(["pnpm", "--filter", "@license-manager/license-checker", "build"], timeout=600)
    log("Update complete. Start the website with:  python main.py --run")


# --------------------------------------------------------------------------
# Menu + dispatch
# --------------------------------------------------------------------------

MENU = """
==================================================
      License Manager - One-Click Launcher
==================================================
  1) Run      - start the complete project and
                open it in your browser
  2) Build    - install + build + type-check +
                test everything once
  3) Update   - fetch the latest code from YOUR
                Git URL, then rebuild
  4) Exit
==================================================
"""

ACTIONS = {"run": action_run, "build": action_build, "update": action_update,
           "reset-admin": lambda: (ensure_pnpm(), migrate_db(), reset_admin_login(),
                                   log("Login is now admin / admin."))}


def prompt_menu() -> str:
    choices = {"1": "run", "2": "build", "3": "update", "4": "exit"}
    while True:
        print(MENU, flush=True)
        choice = input("Select an option [1-4]: ").strip()
        if choice in choices:
            return choices[choice]
        log(f"Invalid choice: {choice!r}. Enter a number from 1 to 4.")


def resolve_action(args) -> str:
    for flag in ("build", "update", "reset-admin", "run"):
        if f"--{flag}" in args:
            return flag
    raise SystemExit(f"Unknown option(s): {' '.join(args)}. Use --run, --build, --update or --reset-admin.")


def main() -> None:
    enable_utf8_console()
    args = sys.argv[1:]
    action = prompt_menu() if not args else resolve_action(args)
    if action == "exit":
        log("Bye.")
        return
    ACTIONS[action]()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("Stopped by user.")
    except subprocess.CalledProcessError as exc:
        log(f"FAILED (exit code {exc.returncode}): {' '.join(exc.cmd)}")
        sys.exit(exc.returncode or 1)
    except RuntimeError as exc:
        log(f"ERROR: {exc}")
        sys.exit(1)
