#!/usr/bin/env python3
"""Compatibility entry point for scripts that used the pre-OpenPostway checkout path."""
from pathlib import Path
from runpy import run_path

if __name__ == "__main__":
    plugins = Path(__file__).resolve().parents[4]
    run_path(str(plugins / "open-postway/skills/open-postway/scripts/mailbox.py"), run_name="__main__")
