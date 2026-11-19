"""Install the API and, in live mode, CPU inference dependencies on a host."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    pip = [sys.executable, "-m", "pip", "install", "--no-cache-dir"]
    demo = os.getenv("DEMO_MODE", "false").lower() == "true"
    if not demo:
        # Avoid downloading the multi-GB CUDA runtime on a CPU web service.
        subprocess.run(
            [*pip, "torch>=2.6,<3", "--index-url", "https://download.pytorch.org/whl/cpu"],
            cwd=root,
            check=True,
        )
    extras = ".[api]" if demo else ".[api,verification]"
    subprocess.run([*pip, "-e", extras], cwd=root, check=True)


if __name__ == "__main__":
    main()

