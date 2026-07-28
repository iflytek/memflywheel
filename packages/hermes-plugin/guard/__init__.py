"""Block host-agent writes into the MemFlywheel-owned memory root."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional


_PATH_WRITE_TOOLS = {"patch", "write_file"}
_COMMAND_TOOLS = {"terminal", "execute_code", "process"}


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))


def _memory_root() -> Path:
    configured = os.environ.get("MEMFLYWHEEL_HOME", "").strip()
    config_path = _hermes_home() / "memflywheel.json"
    if config_path.exists():
        config = json.loads(config_path.read_text(encoding="utf-8"))
        configured = str(config.get("root") or configured).strip()
    return Path(configured or (_hermes_home() / "memflywheel")).expanduser().resolve()


def _path_is_within(candidate: Any, root: Path) -> bool:
    if not isinstance(candidate, str) or not candidate.strip():
        return False
    resolved = Path(os.path.expandvars(os.path.expanduser(candidate))).resolve()
    return resolved == root or root in resolved.parents


def _command_references_root(args: Any, root: Path) -> bool:
    if not isinstance(args, dict):
        return False
    rendered = json.dumps(args, ensure_ascii=False)
    home = Path.home().resolve()
    references = {str(root)}
    try:
        relative = root.relative_to(home).as_posix()
        references.update({f"~/{relative}", f"$HOME/{relative}", f"${{HOME}}/{relative}"})
    except ValueError:
        pass
    return any(reference in rendered for reference in references)


def guard_memory_root(
    tool_name: str = "", args: Any = None, **_: Any
) -> Optional[Dict[str, str]]:
    root = _memory_root()
    if tool_name in _PATH_WRITE_TOOLS and isinstance(args, dict):
        if _path_is_within(args.get("path") or args.get("filePath"), root):
            return {
                "action": "block",
                "message": "MemFlywheel memory is read-only to the host agent; writes are owned by the memory agent loop.",
            }
    if tool_name in _COMMAND_TOOLS and _command_references_root(args, root):
        return {
            "action": "block",
            "message": "MemFlywheel memory is read-only to the host agent; command access to the memory root is blocked.",
        }
    return None


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", guard_memory_root)
