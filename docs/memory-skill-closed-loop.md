# MemScribe Opt-in Memory + Skill Learning Flow / 可选记忆与技能学习装配流

下面是 MemScribe 提供的 **memory + skill learning primitives（记忆与技能学习原语）** 和可选装配方式。当前公开能力是：SDK primitives、opt-in hooks、host assembly。host/adapters can wire prompt 可见、turn-end 触发、tool trajectory 事实轨迹、skill evolution、dream 压缩记忆；这不表示所有入口都会自动启用。

```text
                    MemScribe Opt-in Assembly
                    可选记忆 + 技能学习装配

┌──────────────────────────────────────────────────────────────┐
│ Host Runtime / Agent Harness                                 │
│ 宿主运行时 / Agent Harness                                    │
└───────────────┬───────────────────────────────┬──────────────┘
                │                               │
                │ prompt-build                  │ turn-end / idle / error
                │ 构建主模型 Prompt              │ 生命周期事件
                v                               v

┌──────────────────────────────┐      ┌──────────────────────────────┐
│ Memory Recall                │      │ Opt-in Learning Loop          │
│ 记忆召回                      │      │ 可选学习闭环                  │
│                              │      │                              │
│ MEMORY.md full index          │      │ extraction -> skill -> dream  │
│ 全索引注入，不做向量/top-k     │      │ 抽取 -> 技能沉淀 -> 梦境压缩   │
└───────────────┬──────────────┘      └──────────────┬───────────────┘
                │                                    │
                v                                    v
┌──────────────────────────────┐      ┌──────────────────────────────┐
│ Skill Recall                 │      │ File-Native Stores           │
│ 技能路由召回                  │      │ 文件原生存储                  │
│                              │      │                              │
│ learned skill routes          │      │ memory/*.md                  │
│ path-based skill loading cues  │      │ skills/memscribe-learned-*   │
└──────────────────────────────┘      └──────────────────────────────┘
```

| 层 | 中文定义 | English |
|---|---|---|
| Memory | 记“事实、偏好、项目上下文、短路由 cue” | facts, preferences, context, routing cues |
| Skill | 沉淀“可执行流程、SOP、模板、脚本、校验器” | executable procedures, SOPs, templates, validators |
| Learning Loop | 宿主显式装配后，把重复 workflow 从 memory 里提炼成 skill，再把 memory 压缩成 skill 路由提示 | opt-in host assembly converts repeated workflow memories into skills, then compresses memory into routing cues |

---

```text
1. Prompt Build Flow
   主模型 Prompt 构建链路

Host calls:
宿主调用：

  scribe.onPromptBuild(sessionId)
        │
        v
┌─────────────────────────────────────────────┐
│ buildContext({ root, enabled })             │
│ 构建 memory recall                           │
└─────────────────────────────────────────────┘
        │
        ├─ scanMemoryFiles(root)
        │  扫描 memory/*.md
        │
        ├─ syncMemoryIndex(root, entries)
        │  重建 MEMORY.md
        │
        ├─ readMemoryIndex(root)
        │  读取全量索引
        │
        ├─ truncateIndex + applyAgingHints
        │  截断 + 老化提示
        │
        └─ return:
           ┌────────────────────────────────────┐
           │ systemPrompt                       │
           │ 稳定记忆规则 / stable memory rules │
           └────────────────────────────────────┘
           ┌────────────────────────────────────┐
           │ preludePrompt                      │
           │ MEMORY.md full index               │
           │ wrapped in <system-reminder>       │
           └────────────────────────────────────┘
```

如果配置了 `skillRecall`，会继续走 skill prompt injection：

`skillRecall` 是 SDK opt-in hook。CLI/MCP 默认仍是 memory 面，不会自动注入 learned skills。

```text
        memory context ready
        memory prompt 已生成
              │
              v
┌─────────────────────────────────────────────┐
│ skillRecall({ sessionId })                  │
│ 获取 learned skill routes                   │
└─────────────────────────────────────────────┘
              │
              v
┌─────────────────────────────────────────────┐
│ skillPreludeBuilder(packet)                 │
│ 生成 skill prelude                          │
└─────────────────────────────────────────────┘
              │
              v
Final prompt parts:
最终 Prompt 片段：

systemPrompt =
  memory rules
  +
  skill rules

preludePrompt =
  MEMORY.md full index
  +
  learned skill routes

skillPreludePrompt =
  only skill routing section
```

示意：

```text
┌─────────────────────────────────────────────┐
│ systemPrompt                                │
├─────────────────────────────────────────────┤
│ # 记忆                                      │
│ Memory rules                                │
│                                             │
│ # 技能                                      │
│ Skill rules                                 │
│ - skill is executable package               │
│ - memory must not copy skill steps          │
│ - host owns skill execution                 │
│ - CLI/MCP do not inject skills by default   │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ preludePrompt                               │
├─────────────────────────────────────────────┤
│ <system-reminder>                           │
│ ## 可用记忆条目                             │
│ - preference/foo.md ...                     │
│ - workflow/release-prep.md ...              │
│ </system-reminder>                          │
│                                             │
│ <system-reminder>                           │
│ ## 可用技能                                 │
│ - memscribe-learned-release-review          │
│   path: memscribe-learned-release-review/...│
│   triggers: release prep                    │
│ </system-reminder>                          │
└─────────────────────────────────────────────┘
```

---

```text
2. Turn-End Learning Loop
   回合结束后的学习闭环

Host calls:
宿主调用：

  scribe.onTurnEnd(sessionId, turnMessages)
        │
        v
┌─────────────────────────────────────────────┐
│ Is learningLoop configured?                 │
│ 是否配置 learningLoop？                      │
└───────────────┬─────────────────────────────┘
                │
        no      │      yes
        │       │
        v       v

  extraction only              runLearningLoop(trigger="turn-end")
  只做记忆抽取                  运行宿主装配的闭环
```

宿主装配后的闭环：

```text
runLearningLoop("turn-end")
        │
        v
┌─────────────────────────────────────────────┐
│ Step 1: Extraction                          │
│ 第一步：记忆抽取                             │
└─────────────────────────────────────────────┘
        │
        v
┌─────────────────────────────────────────────┐
│ Step 2: Skill Learning Gate                 │
│ 第二步：技能学习闸门                         │
└─────────────────────────────────────────────┘
        │
        ├─ gate failed
        │  闸门不通过
        │
        │      skip skill evolution
        │      不跑技能沉淀
        │
        └─ gate passed
           闸门通过
                │
                v
┌─────────────────────────────────────────────┐
│ Step 3: Skill Evolution                     │
│ 第三步：技能沉淀 / 更新                      │
└─────────────────────────────────────────────┘
                │
                v
┌─────────────────────────────────────────────┐
│ Step 4: Dream Coordination                  │
│ 第四步：梦境压缩记忆                         │
└─────────────────────────────────────────────┘
```

Gate 规则：

```text
SkillLearningGate
技能学习闸门

source == "local"
enabled == true
skillLearningEnabled == true
doneTurns >= minDoneTurns
turnsSinceLastSkillEvolution >= cooldownTurns
toolCalls >= minToolCalls
```

默认阈值：

| 参数 | 默认值 | 含义 |
|---|---:|---|
| `minDoneTurns` | 3 | 至少完成 3 个 turn |
| `cooldownTurns` | 2 | 距离上次 skill evolution 至少 2 turn |
| `minToolCalls` | 6 | 本轮/窗口至少有 6 次工具调用信号 |

---

```text
3. Extraction Detail
   记忆抽取细节

Extraction step:
记忆抽取步骤：

┌─────────────────────────────────────────────┐
│ acquireLock(root, "extract")                │
│ 获取 memory root 写锁                        │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ relocateRootFiles                           │
│ 修正根目录 stray memory files                │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ scan before state -> manifest               │
│ 扫描已有 memory，生成 manifest               │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ select cursor window                        │
│ 根据 cursor 选择新增消息窗口                 │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ ExtractionAgentRunner                       │
│ 抽取子代理                                  │
│                                             │
│ Tools:                                      │
│ - glob                                      │
│ - grep                                      │
│ - read                                      │
│ - write                                     │
│ - edit                                      │
│ - bash                                      │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ subagent writes files directly              │
│ 子代理通过工具直接写 Markdown 记忆文件        │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ relocate again -> scan -> sync MEMORY.md    │
│ 再修正路径 -> 扫描 -> 重建索引               │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ success?                                    │
│ 是否成功？                                  │
└──────────────┬──────────────────────────────┘
               │
       yes     │      no
       │       │
       v       v
advance cursor  do not advance cursor
推进 cursor      不推进 cursor，后续重试
```

---

```text
4. Tool Trajectory Feedback
   工具轨迹反馈

┌─────────────────────────────────────────────┐
│ Host captures turn messages                 │
│ 宿主采集本轮对话                             │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ messages[].toolCalls                        │
│ 工具调用事实：name / input / output          │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ toolTrajectory                              │
│ 技能沉淀事实源                               │
└───────────────┬─────────────────────────────┘
                │
                v
        used by skill evolution
        进入技能沉淀判断
```

也就是：

```text
tool call facts
工具调用事实
    │
    └──> skill evolution learns from the actual trajectory
         技能沉淀阶段只从真实轨迹学习
```

---

```text
5. Skill Evolution Detail
   技能沉淀细节

When gate passes:
当闸门通过：

┌─────────────────────────────────────────────┐
│ skillEvolution callback                     │
│ 技能沉淀回调                                 │
│                                             │
│ receives:                                  │
│ - sessionId                                 │
│ - lastExtraction                            │
│ - session messages/state                    │
└───────────────────┬─────────────────────────┘
                    │
                    v
Usually host wires:
通常宿主接：

runSkillEvolutionAgent({
  store: createLearnedSkillStore(...),
  reviewPacket,
  toolTrajectory,
  artifactPaths,
  qualitySignals
})
```

Skill agent 的写入模型：

```text
┌─────────────────────────────────────────────┐
│ createSkillCheckpoint()                     │
│ 创建 skill checkpoint                        │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ snapshot live skillsRoot                    │
│ 快照当前 skillsRoot                          │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ create staging area                         │
│ 创建 staging 临时区                           │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ SkillEvolutionRunner                        │
│ 技能沉淀子代理                               │
│                                             │
│ Tools:                                      │
│ - glob                                      │
│ - grep                                      │
│ - read                                      │
│ - write                                     │
│ - edit                                      │
│ - bash                                      │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ writes staging only                         │
│ 只能写 staging，不能直接写 live skillsRoot    │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ final assistant JSON coordination packet    │
│ 最后一条 assistant 消息输出最终协调包         │
└─────────────────────────────────────────────┘
```

协调包：

```ts
interface SkillEvolutionCoordinationPacket {
  decision: "create" | "update" | "merge" | "noop";
  targetSkill: string | null;
  mergedSkills: string[];
  why: string;
  memoryAction: "compress-memory" | "noop";
  memoryTopics: string[];
  supportingFiles: string[];
}
```

关键规则：

| 情况 | 结果 |
|---|---|
| `create/update` | 必须改 exactly one skill |
| `merge` | 必须更新 targetSkill，并 archive 所有 mergedSkills |
| `create/update/merge` | 必须 `memoryAction=compress-memory` |
| `create/update/merge` | 必须有 `memoryTopics` |
| `noop` | 不能改任何 skill 文件 |
| create/update changed skill != targetSkill | fail + rollback |
| merge changed set != targetSkill + mergedSkills | fail + rollback |
| validation failed | fail + rollback |

---

```text
6. Skill Store Finalize / Rollback
   技能文件发布与回滚

After SkillEvolutionRunner:
技能子代理结束后：

┌─────────────────────────────────────────────┐
│ validate coordination packet                │
│ 校验协调包                                   │
└───────────────┬─────────────────────────────┘
                │
                v
┌─────────────────────────────────────────────┐
│ validate changed staged skill               │
│ 校验 staging 中被修改的 skill                │
│                                             │
│ Rules:                                      │
│ - directory: memscribe-learned-<slug>        │
│ - required SKILL.md                          │
│ - strict frontmatter                         │
│ - sections: Use Cases / Procedure / Guardrails│
│ - numbered Procedure                         │
│ - supporting dirs only                       │
│ - no sensitive file names                    │
└───────────────┬─────────────────────────────┘
                │
      valid     │      invalid
      │         │
      v         v
┌─────────────┐  ┌────────────────────────────┐
│ finalize    │  │ rollbackSkillCheckpoint    │
│ 发布到 live │  │ 恢复 snapshot              │
└──────┬──────┘  └────────────────────────────┘
       │
       v
changedSkills + changedFiles
```

---

```text
7. Dream Compression After Skill Update
   技能更新后的记忆压缩

If skill evolution says:
如果技能沉淀返回：

memoryAction = "compress-memory"
memoryTopics = ["release prep"]

then:
则：

┌─────────────────────────────────────────────┐
│ createMemScribe forces dream                │
│ createMemScribe 强制触发 dream               │
└───────────────────┬─────────────────────────┘
                    │
                    v
runDream({
  coordination: {
    reason: packet.why,
    memoryAction: "compress-memory",
    topics: packet.memoryTopics,
    targetSkill: packet.targetSkill
  },
  force: true
})
                    │
                    v
┌─────────────────────────────────────────────┐
│ DreamAgentRunner                            │
│ 梦境整理子代理                               │
│                                             │
│ Must keep memory as routing cue only:        │
│ 记忆只保留短路由提示：                       │
│                                             │
│ "For release prep, use                      │
│  memscribe-learned-release-review."          │
│                                             │
│ Must not copy full skill procedure.          │
│ 不能把完整步骤复制回 memory。                │
└─────────────────────────────────────────────┘
```

宿主显式装配 `learningLoop` 且 gate 通过后的示例效果：

```text
Before:
修改前 memory:

workflow/release-prep.md
  - Step 1: check package metadata
  - Step 2: inspect README
  - Step 3: run npm pack
  - Step 4: scan secrets
  - ...

After:
修改后 memory:

workflow/release-prep.md
  "Release prep is now handled by
   memscribe-learned-release-review.
   Use that skill when release readiness comes up."
```

---

```text
8. Opt-in End-to-End Assembly
   可选端到端装配示例

┌─────────────────────────────────────────────┐
│ User asks / works through repeated workflow │
│ 用户多次执行某类重复工作                      │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ Main model sees memory + skill routes        │
│ 主模型看到 memory recall + skill routes      │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ Host may execute a learned skill             │
│ 宿主可能执行 learned skill                   │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ Host records tool calls in the transcript    │
│ 宿主把工具调用写入本轮消息                    │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ Turn ends                                    │
│ 回合结束                                     │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ Extraction writes durable memory             │
│ extraction 写入长期记忆                      │
└───────────────────┬─────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────┐
│ Gate decides whether skill learning runs     │
│ gate 判断是否跑技能沉淀                      │
└───────────────┬─────────────────────────────┘
                │
        skip    │    run
        │       │
        v       v
   end turn   ┌───────────────────────────────┐
              │ SkillEvolutionRunner          │
              │ 创建/更新 learned skill        │
              └───────────────┬───────────────┘
                              │
                              v
              ┌───────────────────────────────┐
              │ Finalize learned skill         │
              │ 写入本地 skillsRoot            │
              └───────────────┬───────────────┘
                              │
                              v
              ┌───────────────────────────────┐
              │ Dream compresses memory        │
              │ dream 把 workflow memory 压成 cue│
              └───────────────┬───────────────┘
                              │
                              v
              ┌───────────────────────────────┐
              │ Next prompt sees skill route   │
              │ 下一轮 prompt 看到 skill 路由  │
              └───────────────────────────────┘
```

一句话版：

```text
Memory remembers what matters.
记忆保存事实和短路由。

Skill stores how to do repeatable work.
技能沉淀可执行方法。

Prompt sees both.
Prompt 同时看到记忆和技能线索。

Turn-end learns from what happened.
回合结束后从真实执行轨迹学习。

Dream keeps memory short after skill exists.
技能存在后，dream 把长流程记忆压成短 cue。
```
