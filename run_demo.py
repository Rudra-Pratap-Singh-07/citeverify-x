"""Start the offline API and judging workbench together: python run_demo.py."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def wait_for(url: str, process: subprocess.Popen, label: str) -> None:
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"{label} exited with status {process.returncode}")
        try:
            with urllib.request.urlopen(url, timeout=1):
                return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.4)
    raise TimeoutError(f"{label} did not become ready: {url}")


def main() -> int:
    pnpm = shutil.which("pnpm") or shutil.which("pnpm.cmd")
    if not pnpm:
        print("pnpm is required. Install Node.js and pnpm, then retry.", file=sys.stderr)
        return 2
    env = os.environ.copy()
    env["DEMO_MODE"] = "true"
    env.setdefault("CITEVERIFY_TASK_DIR", str(ROOT / "data" / "demo_audits"))
    commands = [
        [sys.executable, "-m", "uvicorn", "api.server:app", "--host", "127.0.0.1", "--port", "8000"],
        [pnpm, "--dir", str(ROOT / "frontend"), "start", "--port", "3001"],
    ]
    processes: list[subprocess.Popen] = []
    try:
        build = subprocess.run([pnpm, "--dir", str(ROOT / "frontend"), "build"], cwd=ROOT, env=env)
        if build.returncode:
            return build.returncode
        for command in commands:
            processes.append(subprocess.Popen(command, cwd=ROOT, env=env))
        wait_for("http://127.0.0.1:8000/api/v1/health", processes[0], "FastAPI")
        wait_for("http://127.0.0.1:3001", processes[1], "Next.js")
        print("CiteVerify-X offline judging mode is ready.")
        print("Workbench: http://127.0.0.1:3001 (select Open synthetic demo)")
        print("API docs:  http://127.0.0.1:8000/docs")
        print("Golden PDFs: tests/benchmarks/")
        while all(process.poll() is None for process in processes):
            time.sleep(1)
    except KeyboardInterrupt:
        print("Stopping CiteVerify-X demo services…")
    except Exception as exc:
        print(f"Demo startup failed: {exc}", file=sys.stderr)
        return 1
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
