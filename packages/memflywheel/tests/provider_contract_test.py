from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import types
from pathlib import Path


class MemoryProvider:
    pass


agent = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
memory_provider.MemoryProvider = MemoryProvider
tools = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")

sys.modules["agent"] = agent
sys.modules["agent.memory_provider"] = memory_provider
sys.modules["tools"] = tools
sys.modules["tools.registry"] = registry

provider_path = Path(__file__).resolve().parents[1] / "provider" / "__init__.py"
spec = importlib.util.spec_from_file_location("memflywheel_provider", provider_path)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)

guard_path = Path(__file__).resolve().parents[1] / "guard" / "__init__.py"
guard_spec = importlib.util.spec_from_file_location("memflywheel_guard", guard_path)
guard_module = importlib.util.module_from_spec(guard_spec)
assert guard_spec and guard_spec.loader
guard_spec.loader.exec_module(guard_module)


class HookCollector:
    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, callback):
        self.hooks[name] = callback


hook_collector = HookCollector()
guard_module.register(hook_collector)
assert "pre_tool_call" in hook_collector.hooks

with tempfile.TemporaryDirectory() as tmp:
    previous_home = os.environ.get("HERMES_HOME")
    os.environ["HERMES_HOME"] = tmp
    try:
        root = str((Path(tmp) / "memflywheel").resolve())
        guard = hook_collector.hooks["pre_tool_call"]
        assert guard("read_file", {"path": f"{root}/preference/test.md"}) is None
        assert guard("patch", {"path": f"{root}/preference/test.md"})["action"] == "block"
        assert guard("write_file", {"path": str(Path(tmp) / "outside.md")}) is None
        assert guard(
            "terminal", {"command": f"sed -i '' s/a/b/ {root}/preference/test.md"}
        )["action"] == "block"
    finally:
        if previous_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = previous_home

provider = module.MemFlywheelMemoryProvider()
assert provider.name == "memflywheel"
assert provider.is_available()

old_worker = os.environ.get("MEMFLYWHEEL_HERMES_WORKER")
os.environ["MEMFLYWHEEL_HERMES_WORKER"] = "/missing/worker.mjs"
assert not provider.is_available()
if old_worker is None:
    os.environ.pop("MEMFLYWHEEL_HERMES_WORKER", None)
else:
    os.environ["MEMFLYWHEEL_HERMES_WORKER"] = old_worker

assert provider.get_tool_schemas() == []
schema_by_key = {item["key"]: item for item in provider.get_config_schema()}
assert schema_by_key["learned_skills"]["default"] == "true"

class Collector:
    def __init__(self):
        self.provider = None

    def register_memory_provider(self, provider):
        self.provider = provider

collector = Collector()
module.register(collector)
assert collector.provider.name == "memflywheel"

with tempfile.TemporaryDirectory() as tmp:
    fake_bin = Path(tmp) / "bin"
    fake_bin.mkdir()
    fake_hermes = fake_bin / "hermes"
    fake_hermes.write_text(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HERMES_HOME/hermes-enable-args\"\n",
        encoding="utf-8",
    )
    fake_hermes.chmod(0o755)
    native_memory = Path(tmp) / "memories" / "MEMORY.md"
    native_memory.parent.mkdir(parents=True)
    native_memory.write_text("native hermes memory\n", encoding="utf-8")
    native_lock = Path(tmp) / "memories" / "MEMORY.md.lock"
    native_lock.write_text("", encoding="utf-8")
    config = Path(tmp) / "config.yaml"
    config.write_text("_config_version: 27\nagent:\n  disabled_toolsets: []\n", encoding="utf-8")

    env = {
        **os.environ,
        "HERMES_HOME": tmp,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}",
    }
    subprocess.run(
        ["node", str(Path(__file__).resolve().parents[1] / "bin" / "install.mjs")],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    installed = Path(tmp) / "plugins" / "memflywheel"
    assert (installed / "__init__.py").exists()
    assert (installed / "worker.mjs").exists()
    assert (installed / "plugin.yaml").exists()
    assert (installed / "install.json").exists()
    guard = Path(tmp) / "plugins" / "memflywheel-guard"
    assert (guard / "__init__.py").exists()
    assert (guard / "plugin.yaml").exists()
    assert (Path(tmp) / "hermes-enable-args").read_text(encoding="utf-8").splitlines() == [
        "plugins",
        "enable",
        "memflywheel-guard",
        "--allow-tool-override",
    ]
    install_metadata = json.loads((installed / "install.json").read_text(encoding="utf-8"))
    assert "packageImport" in install_metadata
    installed_worker = subprocess.run(
        ["node", str(installed / "worker.mjs")],
        cwd=installed,
        env={**env, "MEMFLYWHEEL_PACKAGE_IMPORT": install_metadata["packageImport"]},
        input=json.dumps(
            {
                "type": "command",
                "id": "installed-init",
                "command": "initialize",
                "payload": {
                    "sessionId": "installed-contract",
                    "hermesHome": tmp,
                    "root": str(Path(tmp) / "memflywheel"),
                    "refuseSecrets": True,
                    "learnedSkills": True,
                },
            }
        ) + "\n",
        text=True,
        capture_output=True,
        timeout=20,
        check=True,
    )
    installed_response = json.loads(installed_worker.stdout.strip())
    assert installed_response["type"] == "command_response"
    assert installed_response["id"] == "installed-init"
    assert installed_response.get("error") is None
    disabled_memory = Path(tmp) / "memories.disabled-by-memflywheel" / "MEMORY.md"
    assert disabled_memory.read_text(encoding="utf-8") == "native hermes memory\n"
    assert not native_memory.exists()
    assert not native_lock.exists()
    assert "disabled_toolsets:\n    - memory\n" in config.read_text(encoding="utf-8")


calls = {"n": 0, "first_rounds": []}

learned_skill = """---
name: memflywheel-learned-condensed-research-report
display_name: Condensed Research Report
type: skill
description: Produce a heavily condensed research report.
---

## Use Cases

- Run this when the user asks for a research report.

## Procedure

1. Gather current sources.
2. Write one sentence with the most important finding.

## Guardrails

- Keep the report short.
"""


class Obj:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def call_llm(*, messages, tools, **kwargs):
    has_tool_result = any(message.get("role") == "tool" for message in messages)
    if has_tool_result:
        return Obj(
            choices=[Obj(message=Obj(content="done", tool_calls=None), finish_reason="stop")]
        )

    calls["n"] += 1
    rendered = json.dumps(messages, ensure_ascii=False)
    calls["first_rounds"].append(rendered)
    index = calls["n"]
    content = (
        "---\n"
        "type: preference\n"
        f"name: Hermes E2E {index}\n"
        f"description: Hermes bridge E2E memory {index}.\n"
        'updated: "2026-06-29"\n'
        "---\n\n"
        f"Hermes bridge E2E memory {index}.\n"
    )
    tool_call = Obj(
        id=f"call_{index}",
        function=Obj(
            name="write",
            arguments=json.dumps({"filePath": f"preference/hermes-e2e-{index}.md", "content": content}),
        ),
    )
    return Obj(
        choices=[
            Obj(message=Obj(content=None, tool_calls=[tool_call]), finish_reason="tool_calls")
        ]
    )


auxiliary_client = types.ModuleType("agent.auxiliary_client")
auxiliary_client.call_llm = call_llm
sys.modules["agent.auxiliary_client"] = auxiliary_client

with tempfile.TemporaryDirectory() as tmp:
    provider = module.MemFlywheelMemoryProvider()
    provider.initialize("defaults", hermes_home=tmp)
    assert provider._config["refuse_secrets"] is True
    assert provider._config["learned_skills"] is True
    idle = provider._request("idle", {"force": True})
    assert idle["ran"] is True
    assert idle["reason"] == "ok"
    provider.shutdown()
    calls["n"] = 0
    calls["first_rounds"] = []

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp) / "memflywheel"
    skill_dir = root / "learned-skills" / "memflywheel-learned-condensed-research-report"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(learned_skill, encoding="utf-8")

    provider = module.MemFlywheelMemoryProvider()
    provider.initialize("skill-sync", hermes_home=tmp)
    host_skill = (
        Path(tmp)
        / "skills"
        / "memflywheel"
        / "memflywheel-learned-condensed-research-report"
        / "SKILL.md"
    )
    assert host_skill.read_text(encoding="utf-8") == learned_skill
    context = provider.prefetch("condensed research report", session_id="skill-sync")
    assert "memflywheel-learned-condensed-research-report" in context
    provider.shutdown()

with tempfile.TemporaryDirectory() as tmp:
    custom_root = str(Path(tmp) / "custom-root")
    provider = module.MemFlywheelMemoryProvider()
    provider.save_config(
        {"root": custom_root, "refuse_secrets": "false", "learned_skills": "true"},
        tmp,
    )
    config_path = Path(tmp) / "memflywheel.json"
    assert oct(config_path.stat().st_mode & 0o777) == "0o600"
    provider.initialize("cfg", hermes_home=tmp)
    assert provider._config["root"] == custom_root
    assert provider._config["refuse_secrets"] is False
    assert provider._config["learned_skills"] is True
    provider.shutdown()

with tempfile.TemporaryDirectory() as tmp:
    provider = module.MemFlywheelMemoryProvider()
    provider.initialize("s1", hermes_home=tmp)
    provider.sync_turn(
        "first user raw text",
        "first assistant raw text",
        session_id="s1",
        messages=[
            {"role": "user", "content": "first user raw text"},
            {"role": "assistant", "content": "first assistant raw text"},
        ],
    )
    provider.sync_turn(
        "",
        "",
        session_id="s1",
        messages=[
            {"role": "user", "content": "first user raw text"},
            {"role": "assistant", "content": "first assistant raw text"},
            {"role": "user", "content": "second user raw text"},
            {"role": "assistant", "content": "second assistant raw text"},
        ],
    )
    assert "first user raw text" in calls["first_rounds"][0]
    assert "second user raw text" in calls["first_rounds"][1]

    context = provider.prefetch("Hermes bridge E2E memory 2", session_id="s1")
    assert "hermes-e2e-2.md" in context
    assert "hermes-e2e-2.md" in provider.on_pre_compress([])

    model_calls_before_end = calls["n"]
    provider.on_session_end(
        [
            {"role": "user", "content": "first user raw text"},
            {"role": "assistant", "content": "first assistant raw text"},
            {"role": "user", "content": "second user raw text"},
            {"role": "assistant", "content": "second assistant raw text"},
        ]
    )
    provider.shutdown()
    assert calls["n"] == model_calls_before_end

    root = Path(tmp) / "memflywheel"
    index = (root / "MEMORY.md").read_text(encoding="utf-8")
    assert "hermes-e2e-1.md" in index
    assert "hermes-e2e-2.md" in index

with tempfile.TemporaryDirectory() as tmp:
    provider = module.MemFlywheelMemoryProvider()
    provider.initialize("old", hermes_home=tmp)
    provider.on_session_switch("new", reset=False)
    assert provider._session_id == "new"
