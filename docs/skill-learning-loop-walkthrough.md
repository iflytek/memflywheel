# 技能学习闭环 · 全链路细节（当前代码版）

> 本文档对应**当前实现**：模型只改暂存区技能文件，系统从**真实文件变更**派生协调。

---

## 0. 一句话

```
宿主在 turn-end 把这一轮对话轨迹交给 MemScribe
  → 先做记忆增量提取
  → 提取成功且门控通过，才跑技能演化
  → 技能演化里，模型只用普通文件工具改"暂存沙箱"里的技能文件
  → 系统从"暂存区实际改了哪些技能目录"派生 create/update/merge/noop
  → 非 noop 一律 memoryAction=compress-memory
  → learning-loop 据此自动强制触发 dream
  → dream 把记忆里的流程细节压成"指向该 learned skill 的 cue"
```

MemScribe **从不执行技能**；它只 store / validate / evolve / recall。执行永远是宿主主 Agent 的事。

---

## 1. 大图：两个半环

```
            ┌─────────────────────────  捕获 / 学习 (write path)  ─────────────────────────┐
            │                                                                              │
 宿主对话 ──┼─► turn-end ─► 记忆提取 ─► 技能演化 ─► dream(压缩记忆成 cue)                   │
            │                  │            │            │                                  │
            │                  ▼            ▼            ▼                                  │
            │           memory/*.md   skills/memscribe-learned-*/   MEMORY.md(索引)        │
            └──────────────────────────────────────────────────────────────────────────────┘
                                         │  落盘：文件原生 Markdown + frontmatter
                                         ▼
            ┌─────────────────────────  召回 (read path, 独立)  ───────────────────────────┐
            │  prompt-build ─► 注入 [记忆规则 + MEMORY.md 索引] + [技能规则 + 技能路由索引]   │
            │                 主业务 Agent 用宿主自己的工具读文件 / 决定是否照技能做           │
            └──────────────────────────────────────────────────────────────────────────────┘
```

本文档聚焦**上半环里的技能学习这一段**（turn-end → dream）。

---

## 2. 分层与归属（谁负责哪一段）

```
┌────────────┬──────────────────────────────────────────────────────────────────┐
│ 包          │ 职责                                                              │
├────────────┼──────────────────────────────────────────────────────────────────┤
│ adapters   │ 把宿主事件接到 scribe.onTurnEnd；组装 learnedSkills 装配；按能力     │
│            │ fail-fast。host-memscribe.ts                                       │
│ sdk        │ 学习闭环编排(顺序+门控) learning-loop.ts；turn-end 信号派生         │
│            │ index.ts；技能演化 agent 主循环 skill-evolution-agent.ts           │
│ skills     │ learned-skill store：checkpoint / 暂存 / finalize / 校验 / 回滚    │
│            │ learned-skill.ts                                                  │
│ core       │ 记忆提取 / dream / 文件工具 / 校验                                  │
│ model      │ canonical 模型通道（宿主持有 model 与鉴权）                          │
└────────────┴──────────────────────────────────────────────────────────────────┘
```

---

## 3. 主链路（turn-end learning loop）总览

`scribe.onTurnEnd({sessionId, messages})`
→ `sdk/index.ts: onTurnEnd` → 若配了 learningLoop → `runTurnEndLearningLoop`
→ `sdk/learning-loop.ts: runLearningLoop({trigger:"turn-end", ...})`

```
runLearningLoop(trigger = "turn-end")
│
├─[1]─ maybeRunExtraction ──────────────► extract(sessionId, turnMessages)
│        │                                  └─ 增量提取：游标之后的新消息 + 回看窗口
│        ▼                                     成功才推进游标；结果 = Completed / Skipped / ...
│   extraction.value.result == Completed ?
│        │  否 ──► skillEvolution = skipped("extraction-not-completed")  ──┐
│        │  是                                                              │
│        ▼                                                                  │
├─[2]─ maybeRunSkillEvolution                                              │
│        │  ① skillEvolutionPrerequisite：extraction 必须 Completed         │
│        │  ② shouldRunSkillEvolution(门控，见 §4)                          │
│        │  门控不过 ──► skillEvolution = skipped(reason) ─────────────────┤
│        │  门控过                                                          │
│        ▼                                                                  │
│   skillEvolution() ──► host assembledSkillEvolution ──► runSkillEvolutionAgent (见 §5)
│        │  返回 { coordination, changedSkills, changedFiles }              │
│        ▼                                                                  │
├─[3]─ maybeRunDream(skillEvolution)                                       │
│        │  !ran / !value          ──► skipped("no-skill-coordination") ───┤
│        │  memoryAction == "noop" ──► skipped("memory-action-noop")    ───┤
│        │  !targetSkill           ──► throw                                │
│        │  无 dream runner         ──► skipped("no-dream-runner")      ───┤
│        │  否则                                                            │
│        ▼                                                                  │
│   dream({ reason, memoryAction:"compress-memory", topics, targetSkill }) │
│        └─► sdk dream(coordination, force:true) ──► core runDreamSession   │
│                                                                          ▼
└──────────────────────────────────────────────────► return { extraction, skillEvolution, dream }
```

注：`error` 触发只跑 extraction；`inactive-flush` 触发只跑 skillEvolution（模块支持，但当前出厂只在 turn-end 调用）。

---

## 4. 门控（gate）：要不要跑技能演化

信号在 `sdk/index.ts: runTurnEndLearningLoop` 里**从对话轨迹派生**（宿主可覆盖）：

```
doneTurns                  = stateBeforeTurn.turns + (本轮有消息 ? 1 : 0)
toolCalls                  = 覆盖值 ?? countToolCalls(本会话消息)
                             └─ countToolCalls = Σ ExtractionMessage.toolCalls.length
turnsSinceLastSkillEvolution = 覆盖值 ?? (doneTurns - lastSkillEvolutionTurn[session])
```

`sdk/learning-loop.ts: shouldRunSkillEvolution` 逐条硬门（任一不过即跳过）：

```
┌──────────────────────────────┬──────────────┬───────────────────────────┐
│ 条件                          │ 默认阈值      │ 失败原因 reason            │
├──────────────────────────────┼──────────────┼───────────────────────────┤
│ source === "local"           │ —            │ non-local-source          │
│ enabled                      │ —            │ disabled                  │
│ skillLearningEnabled         │ —            │ skill-learning-disabled   │
│ doneTurns >= minDoneTurns    │ 3            │ min-done-turns            │
│ turnsSince... >= cooldownTurns│ 2            │ cooldown-turns            │
│ toolCalls >= minToolCalls    │ 6            │ min-tool-calls            │
│ (前置) extraction == Completed│ —            │ extraction-not-completed  │
└──────────────────────────────┴──────────────┴───────────────────────────┘
DEFAULT_SKILL_LEARNING_GATE = { minDoneTurns:3, cooldownTurns:2, minToolCalls:6 }
门控全过后，跑成功一次 → lastSkillEvolutionTurn[session] = 当前 turns（用于 cooldown）
```

---

## 5. 技能演化 agent 内部（本闭环的心脏）

入口：`sdk/skill-evolution-agent.ts: runSkillEvolutionAgent`。
核心思想：**模型只改文件；系统从真实文件变更派生一切。模型不吐任何 JSON。**

### 5.1 沙箱与 checkpoint 布局（`skills/learned-skill.ts`）

```
skillsRoot/                         ← 已发布的 learned skills（对外、可被召回/执行）
  memscribe-learned-foo/SKILL.md
checkpointRoot/                     ← 必须与 skillsRoot 互不包含 (assertSeparateRoots)
  <uuid>/
    stage/      ← 模型的所有写操作落这里（已发布内容的副本 + 模型的改动）
    snapshot/   ← 回滚用的发布前快照
    store-checkpoint.json  (manifest: skillsRoot/stageRoot/snapshotRoot/beforeFiles...)

createSkillCheckpoint():
  beforeFiles = 指纹快照(skillsRoot)            ← 用于 finalize 时检测外部篡改
  若 skillsRoot 已存在: copyTree(skillsRoot → stage) 且 copyTree(skillsRoot → snapshot)
```

模型工具由 `bindStageFileTool` 包装，**全部绑定到 stageRoot**：

```
read / write / edit / glob / grep / bash   →  root = manifest.stageRoot, mode = "files"
                                              （写操作进沙箱，不碰 skillsRoot）
bash 额外守卫：拒绝任何"绝对路径"(以 / 开头的 token) 或绝对 workdir
  └─ 防御纵深：/bin/sh -lc 本可用绝对路径逃逸沙箱；技能演化合法用途只需相对路径
```

### 5.2 模型主循环（`runSkillToolLoop`）

```
seed(system) = DEFAULT_SKILL_EVOLUTION_SYSTEM_PROMPT
               └─ "用文件工具改技能文件；相对路径；用 write 工具；不必吐 JSON"
seed(user)   = # Review packet / # Learned skill index(★净化) / # Tool trajectory
               / # Artifact paths / # Quality signals
  ★净化：sanitizeSkillIndex 只保留 name/displayName/description/relativePath/skillContent
         绝不暴露 skillsRoot 的绝对路径（否则模型会用 bash 绝对路径直写 skillsRoot → 越界）

loop:
  model.complete({messages, tools})        ← 宿主持有的真实 model（DeepSeek 等）
  有 tool_calls → 逐个 handler 执行（写进 stage），结果回灌；继续
  无 tool_calls → 结束（finalContent 仅留痕，不参与决策）
  上限 maxSteps（默认 12，硬顶 20）
```

### 5.3 收尾：派生 + finalize（`runSkillEvolutionAgent`）

```
catalogNames  = getLearnedSkillsCatalog() 里每个技能的目录名集合（演化前的已发布技能）
stagedNames   = listStagedSkillNames(tools) = glob "*/SKILL.md" on stage → 目录名集合
deletedNames  = catalogNames \ stagedNames        （演化前有、演化后没了 = 被删，merge 信号）

finalize = store.finalizeLearnedSkillChanges({
             checkpoint,
             learningSummary.coordination = deletedNames>0 ? {decision:"merge", mergedSkills:deletedNames}
                                                            : NOOP        ← 仅供 finalize 授权删除
           })
   │  （见 §6 的 finalize 安全 / 发布 / 剥离 / 返回 changeSet）
   ▼
changeSet = { changedSkills:[目录名...], changedFiles:[相对路径...] }

coordination = deriveCoordination({ changeSet, catalogNames, deletedNames })   ← 见 §5.4
validateSkillEvolutionCoordination(coordination)   ← 结构 + 字段硬校验
validateSkillEvolutionChangeSet(coordination, changeSet) ← 协调 与 真实变更 必须一致

返回 { ...changeSet, coordination, learnedSkillIndex, toolCalls, stoppedReason, steps }
任一步抛错 → store.rollbackSkillCheckpoint（snapshot 还原 skillsRoot）→ 重新抛出
```

### 5.4 派生决策表（`deriveCoordination` —— 系统从真实变更推断，不靠模型自述）

```
┌───────────────────────────────────────┬───────────┬──────────────┬──────────────────┐
│ 真实文件变更                           │ decision  │ targetSkill  │ mergedSkills     │
├───────────────────────────────────────┼───────────┼──────────────┼──────────────────┤
│ changedSkills 为空                     │ noop      │ null         │ []               │
│ 有 deletedNames 且有幸存(非删)技能     │ merge     │ 幸存[0]      │ deletedNames     │
│ 无删除，targetSkill ∉ catalog          │ create    │ 变更技能     │ []               │
│ 无删除，targetSkill ∈ catalog          │ update    │ 变更技能     │ []               │
└───────────────────────────────────────┴───────────┴──────────────┴──────────────────┘

非 noop 时（这就是记忆↔技能联动的来源）：
   memoryAction = "compress-memory"                ← 一律，不再依赖模型
   memoryTopics = [ humanizeSkillSlug(targetSkill) ]
                  └─ "memscribe-learned-monorepo-release" → "monorepo release"
   why          = "<decision> <targetSkill> from the observed reusable method"
noop 时：
   memoryAction = "noop", memoryTopics = []        → dream 不触发（§3 [3] 会 skip）
```

---

## 6. finalize：发布 + 安全 + 泄漏剥离（`finalizeLearnedSkillStoreCheckpoint`）

```
[安全门 1] 自 checkpoint 起 skillsRoot 不得被外部改动
           diff(beforeFiles, 当前 skillsRoot) 非空 → throw FinalizeSafetyError
           （正常情形下模型只写 stage，skillsRoot 不变 → 通过。曾经的 mode③ 崩溃就是
             模型经 bash 绝对路径直写 skillsRoot 触发了它；§5.2 的净化+守卫已根治）
[计算]     stagedDiff = diff(beforeFiles, stage)  → changedPaths / deletedPaths
[安全门 2] 删除必须是"整目录删除"，且只允许删 learningSummary 授权的 mergedSkills
           部分删除 / 越权删除 → throw FinalizeSafetyError
[安全门 3] 每个被改的技能目录 validateLearnedSkillDirectory（合法 SKILL.md：frontmatter
           name==目录名、## Use Cases/## Procedure(连续编号)/## Guardrails）→ 不合法即 throw
[发布]     对每个变更技能： rm skillsRoot/<skill> ; copyTree stage/<skill> → skillsRoot/<skill>
[返回]     changedSkills(名), changedFiles(相对路径)
出错 → restoreStoreSnapshot（用 snapshot 还原整个 skillsRoot）
```

---

## 7. dream 联动：把记忆压成指向技能的 cue

`maybeRunDream`（§3 [3]）在 `coordination.memoryAction === "compress-memory"` 时强制触发：

```
maybeRunDream → options.dream({ reason:why, memoryAction:"compress-memory",
                                topics:memoryTopics, targetSkill })
   │  (sdk/index.ts dream 回调)
   ▼
dream({ coordination:{reason,memoryAction,topics,targetSkill}, force:true }, /*coordination*/true)
   │  (core runDreamSession，全程持 per-root 写锁)
   ▼
Phase 1 确定性结构 pre-pass（无 LLM，始终跑）：删完全重复、按 type 重定位
Phase 2 语义巩固 subagent（需配 dreamRunner=有 model）：
        收到 coordination 作为"偏置指令"（compress-memory + topics + targetSkill），
        通读相关记忆，把"流程细节"压缩成一条指向 learned skill 的 cue
   ▼
syncMemoryIndex 确定性重建 MEMORY.md
```

> 关键：dream 是否真把记忆压成 cue，是 dreamRunner(LLM) 的 prompt 引导效果；
> "**触发**"本身是确定性的（memoryAction=compress-memory 必触发）——这就是 K6 断言验证的点。

---

## 8. 召回侧（read path，独立于上面）

```
scribe.onPromptBuild
  ├─ 记忆：buildContext → systemPrompt(稳定记忆规则) + preludePrompt(MEMORY.md 索引, 可能截断)
  └─ 技能：skillRecall + skillPrelude → skillPreludePrompt
            └─ "## 可用技能\n- <name>: <displayName> — <description>\n  path: <relativePath>\n  triggers:..."
主业务 Agent 看到技能路由(name/path/triggers) → 命中时用宿主自己的工具读 SKILL.md 并照做
MemScribe 不执行、不包装主 Agent 的读/执行链路
```

---

## 9. 分支 / 异常 / 安全 速查

```
┌────────────────────────────┬───────────────────────────────────────────────────────┐
│ 情形                        │ 结果                                                  │
├────────────────────────────┼───────────────────────────────────────────────────────┤
│ 提取未 Completed            │ 跳过技能演化（extraction-not-completed），不崩          │
│ 门控不过                    │ 跳过技能演化（min-*/cooldown/...），不崩               │
│ 模型没改任何技能文件        │ deriveCoordination → noop；dream skip；不崩，不回滚      │
│ 模型写了不合法 SKILL.md     │ finalize 安全门 3 抛错 → 回滚 → onTurnEnd 抛（宿主吞）  │
│ 变更技能数 ≠ 预期(如双 create)│ validateSkillEvolutionChangeSet 抛 → 回滚              │
│ 模型用 bash 绝对路径        │ bindStageFileTool 守卫拒绝（返回 ok:false 回灌给模型）  │
│ skillsRoot 被外部篡改        │ finalize 安全门 1 抛 FinalizeSafetyError → 回滚         │
│ create/update/merge         │ memoryAction=compress-memory → dream 必触发（联动）     │
│ noop                        │ memoryAction=noop → dream 不触发                        │
└────────────────────────────┴───────────────────────────────────────────────────────┘
```

不变量：发布的技能包永远是合法包（含 SKILL.md，只允许 supporting dirs）；
模型工具写入限制在 stage 沙箱；finalize 由系统发布到 skillsRoot；失败一律回滚到发布前快照；MemScribe 永不执行技能。

---

## 10. 文件 / 函数索引

```
adapters/src/host-memscribe.ts      createMemScribeHarnessRuntime / assembledSkillEvolution / fail-fast
sdk/src/index.ts                    onTurnEnd → runTurnEndLearningLoop（信号派生）；dream 回调
sdk/src/learning-loop.ts            runLearningLoop / shouldRunSkillEvolution / maybeRunDream / 门控常量
sdk/src/skill-evolution-agent.ts    runSkillEvolutionAgent / runSkillToolLoop / listStagedSkillNames /
                                    deriveCoordination / humanizeSkillSlug / 两个 validate*
skills/src/learned-skill.ts         createLearnedSkillStore / createSkillCheckpoint / bindStageFileTool(bash 守卫) /
                                    finalizeLearnedSkillStoreCheckpoint(安全/发布/剥离) / 回滚 / 包校验
core/src/extract.ts                 增量记忆提取
core/src/dream.ts                   runDreamSession（pre-pass + dreamRunner）
```

## 11. 端到端验证

`examples/pi/e2e-strict.mjs`（严格、无 warn 兜底，单次=生产语义）覆盖：
S0 确定性机制 · M 记忆闭环 · K1–K6 技能闭环（创建/合法包/召回/decision/不泄漏/**dream 联动**）·
P 反向代理断言。真实 DeepSeek 单次实测 27 pass / 0 fail。
