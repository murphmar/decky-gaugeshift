#!/usr/bin/env python3
"""Fails if Gaugeshift gains abilities it doesn't need.

Gaugeshift only reads and changes one Steam setting, stores its own settings
file, and reads Steam's console log. This check keeps it that way: it fails
the build if the plugin asks for root, if any code could reach the network,
run other programs or load code at runtime, or if the frontend calls a
backend method that isn't on the list.

Run after building (it also checks the built bundle): python3 scripts/check_safety.py
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Standard-library modules the backend may import. Anything else (network,
# processes, native code, ...) needs a deliberate change here, in review.
ALLOWED_PY_IMPORTS = {"__future__", "asyncio", "json", "os", "re", "tempfile", "decky"}
# Built-ins that run code from strings, and os/shutil functions that run
# programs or change permissions or delete trees.
FORBIDDEN_PY_BUILTINS = {"eval", "exec", "compile", "__import__"}
FORBIDDEN_PY_METHODS = {
    "system",
    "popen",
    "spawnl",
    "spawnv",
    "execv",
    "execve",
    "execvp",
    "fork",
    "rmtree",
    "chmod",
    "chown",
}

# Backend methods the frontend may call.
ALLOWED_BACKEND_METHODS = {"get_config", "save_config", "known_screens", "log"}

FORBIDDEN_JS = {
    r"\bfetch\s*\(": "network request (fetch)",
    r"fetchNoCors": "network request (Decky fetchNoCors)",
    r"XMLHttpRequest": "network request (XMLHttpRequest)",
    r"\bWebSocket\b": "network connection (WebSocket)",
    r"\bEventSource\b": "network connection (EventSource)",
    r"sendBeacon": "network request (sendBeacon)",
    r"\beval\s*\(": "runs code from a string (eval)",
    r"new\s+Function\s*\(": "runs code from a string (new Function)",
    r"\bimport\s*\(": "loads code at runtime (dynamic import)",
    r"openFilePicker": "file access (Decky file picker)",
}
# URLs allowed in the bundle: the SVG namespace used by the icon library.
ALLOWED_URLS = {"http://www.w3.org/2000/svg"}

errors: list[str] = []


def check_plugin_json() -> None:
    data = json.loads((ROOT / "plugin.json").read_text())
    flags = data.get("flags", [])
    if flags:
        errors.append(f"plugin.json: flags must be empty (no root access), found {flags}")


def check_backend() -> None:
    tree = ast.parse((ROOT / "main.py").read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [a.name.split(".")[0] for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            names = [(node.module or "").split(".")[0]]
        else:
            names = []
        for name in names:
            if name not in ALLOWED_PY_IMPORTS:
                errors.append(f"main.py:{node.lineno}: imports {name!r}, which isn't on the allowed list")
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in FORBIDDEN_PY_BUILTINS:
                errors.append(f"main.py:{node.lineno}: calls {func.id}()")
            if isinstance(func, ast.Attribute) and func.attr in FORBIDDEN_PY_METHODS:
                errors.append(f"main.py:{node.lineno}: calls .{func.attr}()")


def check_frontend(paths: list[Path]) -> None:
    for path in paths:
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(ROOT)
        for pattern, what in FORBIDDEN_JS.items():
            for m in re.finditer(pattern, text):
                line = text.count("\n", 0, m.start()) + 1
                errors.append(f"{rel}:{line}: {what}")
        for url in sorted(set(re.findall(r"https?://[^\s\"'`)]+", text)) - ALLOWED_URLS):
            errors.append(f"{rel}: contains URL {url}")
        if path.parent.name == "src":
            for method in re.findall(r"callable<[^>]*>\(\s*\"([^\"]+)\"", text, flags=re.S):
                if method not in ALLOWED_BACKEND_METHODS:
                    errors.append(f"{rel}: calls backend method {method!r}, which isn't on the allowed list")


def main() -> int:
    check_plugin_json()
    check_backend()
    sources = sorted((ROOT / "src").rglob("*.ts")) + sorted((ROOT / "src").rglob("*.tsx"))
    bundle = ROOT / "dist" / "index.js"
    if not bundle.exists():
        errors.append("dist/index.js not found: build first (pnpm build)")
    else:
        sources.append(bundle)
    check_frontend(sources)

    if errors:
        print("Safety check failed:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("Safety check passed: no root, no network, no subprocesses, no runtime code loading.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
