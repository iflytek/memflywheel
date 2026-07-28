"""MemFlywheel Hermes MemoryProvider.

File-native recall, turn-end extraction, and session-end cleanup. The provider
keeps Hermes as the owner of model routing and auth by calling
``agent.auxiliary_client.call_llm``.
"""

from __future__ import annotations

import json
import os
import select
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def _load_config(hermes_home: Optional[Path] = None) -> dict:
    home = hermes_home or _hermes_home()
    config = {
        "hermes_home": str(home),
        "root": os.environ.get("MEMFLYWHEEL_HOME", ""),
        "refuse_secrets": _env_bool("MEMFLYWHEEL_REFUSE_SECRETS", True),
        "learned_skills": _env_bool("MEMFLYWHEEL_LEARNED_SKILLS", True),
        "timeout": int(os.environ.get("MEMFLYWHEEL_HERMES_TIMEOUT", "180")),
        "command_timeout": int(os.environ.get("MEMFLYWHEEL_HERMES_COMMAND_TIMEOUT", "600")),
    }
    config.update({k: v for k, v in _load_json(home / "memflywheel.json").items() if v not in (None, "")})
    if not config.get("root"):
        config["root"] = str(home / "memflywheel")
    return config


def _worker_path() -> Path:
    explicit = os.environ.get("MEMFLYWHEEL_HERMES_WORKER")
    if explicit:
        return Path(explicit)
    here = Path(__file__).resolve().parent
    installed = here / "worker.mjs"
    if installed.exists():
        return installed
    return here.parent / "bridge" / "worker.mjs"


def _install_config() -> dict:
    try:
        return _load_json(Path(__file__).resolve().parent / "install.json")
    except Exception:
        return {}


def _worker_import_ok() -> bool:
    if not shutil.which("node") or not _worker_path().exists():
        return False
    env = os.environ.copy()
    package_import = _install_config().get("packageImport")
    if package_import:
        env["MEMFLYWHEEL_PACKAGE_IMPORT"] = package_import
    script = "await import(process.env.MEMFLYWHEEL_PACKAGE_IMPORT || '@iflytekopensource/memflywheel')"
    try:
        return (
            subprocess.run(
                ["node", "--input-type=module", "-e", script],
                cwd=Path(__file__).resolve().parent.parent,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            ).returncode
            == 0
        )
    except Exception:
        return False


def _get(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _first_choice(response: Any) -> Any:
    choices = _get(response, "choices", [])
    if not choices:
        raise RuntimeError("Hermes LLM response has no choices")
    return choices[0]


def _parse_tool_args(raw: Any) -> Any:
    if raw in (None, ""):
        return {}
    if isinstance(raw, str):
        return json.loads(raw)
    return raw


def _text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        part.get("text", "")
        for part in content
        if isinstance(part, dict) and part.get("type") == "text"
    )


def _to_openai_message(message: dict) -> dict:
    role = message.get("role")
    if role == "toolResult":
        return {
            "role": "tool",
            "tool_call_id": message.get("toolCallId"),
            "content": _text_content(message.get("content")),
        }
    calls = [
        part
        for part in message.get("content", [])
        if isinstance(part, dict) and part.get("type") == "toolCall"
    ] if role == "assistant" else []
    wire = {"role": role, "content": _text_content(message.get("content")) or None}
    if calls:
        wire["tool_calls"] = [
            {
                "id": call["id"],
                "type": "function",
                "function": {
                    "name": call["name"],
                    "arguments": json.dumps(call.get("arguments") or {}, ensure_ascii=False),
                },
            }
            for call in calls
        ]
    return wire


def _to_openai_tool(tool: dict) -> dict:
    return {
        "type": "function",
        "function": {
            "name": tool["name"],
            "description": tool.get("description", ""),
            "parameters": tool["parameters"],
        },
    }


def _pi_response(response: Any) -> dict:
    choice = _first_choice(response)
    raw_message = _get(choice, "message", {})
    content = []
    text = _get(raw_message, "content")
    if text:
        content.append({"type": "text", "text": text})
    for raw_call in _get(raw_message, "tool_calls", []) or []:
        fn = _get(raw_call, "function", {})
        content.append(
            {
                "type": "toolCall",
                "id": _get(raw_call, "id"),
                "name": _get(fn, "name"),
                "arguments": _parse_tool_args(_get(fn, "arguments")),
            }
        )
    usage = _get(response, "usage", {}) or {}
    input_tokens = _get(usage, "prompt_tokens", 0) or 0
    output_tokens = _get(usage, "completion_tokens", 0) or 0
    has_tools = any(part.get("type") == "toolCall" for part in content)
    return {
        "role": "assistant",
        "content": content,
        "api": "openai-completions",
        "provider": "hermes",
        "model": _get(response, "model", "host-active"),
        "usage": {
            "input": input_tokens,
            "output": output_tokens,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": input_tokens + output_tokens,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
        },
        "stopReason": "toolUse" if has_tools else "stop",
        "timestamp": int(time.time() * 1000),
    }


class _MemFlywheelBridge:
    def __init__(self, provider: "MemFlywheelMemoryProvider"):
        self._provider = provider
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._next_id = 1

    def close(self) -> None:
        proc = self._proc
        self._proc = None
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    def request(self, command: str, payload: dict, timeout: int) -> Any:
        with self._lock:
            proc = self._ensure_process()
            req_id = f"cmd-{self._next_id}"
            self._next_id += 1
            self._write(proc, {"type": "command", "id": req_id, "command": command, "payload": payload})
            deadline = time.monotonic() + timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.close()
                    raise TimeoutError(f"MemFlywheel worker command timed out: {command}")
                readable, _, _ = select.select([proc.stdout], [], [], remaining)
                if not readable:
                    self.close()
                    raise TimeoutError(f"MemFlywheel worker command timed out: {command}")
                line = proc.stdout.readline()
                if line == "":
                    detail = proc.stderr.read().strip() if proc.stderr else ""
                    suffix = f": {detail}" if detail else ""
                    raise RuntimeError(f"MemFlywheel worker exited{suffix}")
                message = json.loads(line)
                msg_type = message.get("type")
                if msg_type == "model_request":
                    self._handle_model_request(proc, message)
                    continue
                if msg_type == "command_response" and message.get("id") == req_id:
                    if message.get("error"):
                        raise RuntimeError(message["error"].get("message", "MemFlywheel worker error"))
                    return message.get("result")
                if msg_type == "protocol_error":
                    raise RuntimeError(message.get("error", {}).get("message", "MemFlywheel protocol error"))

    def _ensure_process(self) -> subprocess.Popen:
        if self._proc and self._proc.poll() is None:
            return self._proc
        env = os.environ.copy()
        package_import = _install_config().get("packageImport")
        if package_import:
            env["MEMFLYWHEEL_PACKAGE_IMPORT"] = package_import
        self._proc = subprocess.Popen(
            ["node", str(_worker_path())],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=env,
        )
        return self._proc

    @staticmethod
    def _write(proc: subprocess.Popen, message: dict) -> None:
        proc.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        proc.stdin.flush()

    def _handle_model_request(self, proc: subprocess.Popen, message: dict) -> None:
        try:
            result = self._provider.complete_model(message["request"])
            self._write(proc, {"type": "model_response", "id": message["id"], "result": result})
        except Exception as exc:
            self._write(
                proc,
                {"type": "model_response", "id": message["id"], "error": {"message": str(exc)}},
            )


class MemFlywheelMemoryProvider(MemoryProvider):
    def __init__(self):
        self._config = {}
        self._session_id = "default"
        self._bridge = _MemFlywheelBridge(self)

    @property
    def name(self) -> str:
        return "memflywheel"

    def is_available(self) -> bool:
        return _worker_import_ok()

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "root",
                "description": "MemFlywheel memory root. Empty uses $HERMES_HOME/memflywheel.",
                "default": "",
            },
            {
                "key": "refuse_secrets",
                "description": "Refuse writes that contain detected secrets.",
                "default": "true",
                "choices": ["true", "false"],
            },
            {
                "key": "learned_skills",
                "description": "Enable learned skill evolution.",
                "default": "true",
                "choices": ["true", "false"],
            },
        ]

    def save_config(self, values, hermes_home):
        config_path = Path(hermes_home) / "memflywheel.json"
        existing = _load_json(config_path)
        clean = dict(existing)
        for key, value in dict(values or {}).items():
            if key in {"refuse_secrets", "learned_skills"} and isinstance(value, str):
                clean[key] = value.lower() in {"1", "true", "yes", "on"}
            else:
                clean[key] = value
        config_path.write_text(json.dumps(clean, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        config_path.chmod(0o600)

    def initialize(self, session_id: str, **kwargs) -> None:
        hermes_home = Path(kwargs.get("hermes_home") or _hermes_home())
        self._config = _load_config(hermes_home)
        self._session_id = session_id or "default"
        self._request("initialize", {"sessionId": self._session_id})

    def system_prompt_block(self) -> str:
        return (
            "# MemFlywheel Memory\n"
            "Active. File-native long-term memory and learned skills are available. "
            "Use the injected memory context before acting."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        result = self._request("prompt_build", {"sessionId": session_id or self._session_id, "query": query})
        return result.get("context", "") if isinstance(result, dict) else ""

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        payload = {
            "sessionId": session_id or self._session_id,
            "userContent": user_content,
            "assistantContent": assistant_content,
        }
        if messages:
            payload["messages"] = messages
        self._request(
            "turn_end",
            payload,
        )

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        self._request("session_end", {"sessionId": self._session_id})

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        rewound: bool = False,
        **kwargs,
    ) -> None:
        if reset and self._session_id:
            self._request("session_end", {"sessionId": self._session_id})
        self._session_id = new_session_id or self._session_id
        self._request("initialize", {"sessionId": self._session_id})

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        result = self._request(
            "prompt_build",
            {"sessionId": self._session_id, "query": "current task state before compression"},
        )
        return result.get("context", "") if isinstance(result, dict) else ""

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return []

    def shutdown(self) -> None:
        self._bridge.close()

    def complete_model(self, request: dict) -> dict:
        from agent.auxiliary_client import call_llm

        context = request.get("context", {})
        messages = [_to_openai_message(m) for m in context.get("messages", [])]
        if context.get("systemPrompt"):
            messages.insert(0, {"role": "system", "content": context["systemPrompt"]})
        response = call_llm(
            task=None,
            messages=messages,
            tools=[_to_openai_tool(t) for t in context.get("tools", [])],
            timeout=self._config.get("timeout", 180),
        )
        return _pi_response(response)

    def _request(self, command: str, payload: dict) -> Any:
        payload = {
            **payload,
            "hermesHome": self._config.get("hermes_home"),
            "root": self._config.get("root"),
            "refuseSecrets": self._config.get("refuse_secrets") is True,
            "learnedSkills": self._config.get("learned_skills") is True,
        }
        return self._bridge.request(command, payload, timeout=int(self._config.get("command_timeout", 600)))


def register(ctx) -> None:
    ctx.register_memory_provider(MemFlywheelMemoryProvider())
