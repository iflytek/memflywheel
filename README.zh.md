# MemFlywheel

让 Agent 把每一次执行，沉淀成下一次更懂你的开始。

MemFlywheel 是一个面向 AI Agent Harness 的文件原生长期记忆与技能学习层。

它把 Agent 在对话中的偏好理解、工具调用轨迹、项目约定、失败教训和重复工作流，沉淀为可审计、可迁移、可演化的 Markdown 记忆与 learned skills。

记忆不再是上下文里的临时片段，也不是黑盒服务里的隐形状态，而是可以被检查、被 diff、被归档、被复用的工程资产。

<!--
IMAGE_PLACEHOLDER: docs/assets/readme/01-overview.png
生图提示词:
技术手绘白板风格架构图，浅色纸张背景，黑色手绘线条，少量蓝色和绿色强调。画面中心是 "MemFlywheel"，左侧是 "Host Agent / Harness"，标注 model、auth、tools、lifecycle 由宿主拥有；右侧是文件原生存储，包括 MEMORY.md、typed markdown memories、.memflywheel/sources、learned skills；用环形箭头表现 memory -> recall -> skill -> dream -> memory 的飞轮闭环。整体简洁、工程感强、无 3D、无渐变、无人物。
-->

## 为什么需要 MemFlywheel

多数现有 Agent memory 方案，通常从“记忆存储与召回”出发：把对话、偏好或知识抽取进 memory store、向量库、知识图谱或框架内存储，再在后续任务中通过搜索、检索或上下文注入重新使用。

MemFlywheel 采用 agent-native 优先策略，关注的是 Agent Harness 里更靠近执行现场的一层：不仅保存“记住了什么”，还沉淀“为什么这样做、哪里失败过、哪些流程值得复用”，并把这些经验落成可审计、可迁移、可演化的文件资产。

| 对比维度 | 常见 memory 方案 | MemFlywheel |
|---|---|---|
| 关注点 | 记忆存储、搜索召回、上下文注入 | 执行经验沉淀、证据追溯、技能演化 |
| 记忆对象 | 对话、偏好、知识片段 | 偏好理解、项目约定、工具轨迹、失败教训、重复流程 |
| 存储形态 | API、向量库、知识图谱、框架内 Store | Markdown memories、`MEMORY.md`、`.memflywheel/sources`、learned skills |
| 召回方式 | 检索相关片段后注入 prompt | 预召回 → 索引线索 → 记忆正文 → 原始轨迹 |
| 学习闭环 | 通常聚焦“记忆能否被召回” | 重复流程沉淀为 learned skill，并反向整理长期记忆 |
| 工程治理 | 依赖服务或框架内部状态 | 文件可读、可 diff、可归档、索引可重建 |

它也不接管模型、工具和主 Agent 执行。模型服务、鉴权、业务工具和任务决策仍然属于宿主 Agent / Harness；MemFlywheel 只嵌入 prompt-build、turn-end、session-end、idle 等生命周期，负责长期记忆、技能学习和文件化治理。

## MemFlywheel 是什么

| 维度 | 说明 |
|---|---|
| 定位 | Agent Harness 内部的 memory foundation component |
| 存储 | Markdown body + YAML frontmatter |
| 索引 | `MEMORY.md` 是可重建索引，LLM 不直接维护它 |
| 召回 | prompt-build 注入记忆规则和索引线索，主 Agent 自己读取相关文件 |
| 整理 | dream agent 在 idle 或强制触发时合并、压缩、归档和修复结构 |
| 技能 | 把可复用流程沉淀为 `memflywheel-learned-*/SKILL.md` |
| 模型 | core 不调用 LLM；模型、鉴权和生命周期由宿主或 SDK 注入 |
| 接入 | 通过 SDK 和 adapters 接入 Pi、Hermes、OpenClaw、OpenCode 等宿主 |



## 核心流程

```text
Any Host Agent / Harness
  Pi · Hermes · OpenClaw · OpenCode · custom harness
  owns model · auth · tools · policy · business execution
        |
        | plug in through SDK hooks / host adapter
        v
MemFlywheel lifecycle hooks
        |
        +-- prompt-build
        |     +-- scan memory files and build MEMORY.md index
        |     +-- if index is small: inject full index cues
        |     +-- if index is large: run index-layer pre-retrieval
        |     |     +-- embedding + BM25 + RRF over MEMORY.md lines
        |     |     +-- inject top relevant index cues
        |     +-- inject recall rules
        |     +-- optional learned-skill routes
        |     |
        |     +-- Main Agent decides what to read
        |           selected/full index cue -> memory .md body -> .memflywheel/sources trace
        |
        +-- turn-end / agent-end / session-end
        |     +-- collect new transcript + tool trajectory
        |     +-- write cleaned trace to .memflywheel/sources
        |     +-- extraction subagent decides create / update / merge / archive / noop
        |     +-- write memory files and rebuild MEMORY.md
        |
        +-- skill learning gate
        |     +-- after successful extraction, check turns / tool calls / cooldown
        |     +-- evolve learned skills: create / update / merge / noop
        |     +-- if skill changed, force dream to compress related memory into skill cues
        |
        +-- idle / forced dream
        |     +-- deterministic cleanup
        |     +-- optional dream subagent consolidation
        |     +-- dedupe / compress / archive / retag
        |     +-- rebuild MEMORY.md
        |
        v
Next turn / next session
  gets cleaner index cues + richer memories + reusable learned skills
        |
        +---------------------------------------------------------------+
        |                                                               |
        +---------------- back to prompt-build --------------------------+
```

<!--
IMAGE_PLACEHOLDER: docs/assets/readme/02-lifecycle.png
生图提示词:
技术手绘流程图，白板风格，展示 MemFlywheel 的生命周期闭环。节点包括 prompt-build、main agent turn、turn-end extraction、skill evolution gate、dream consolidation、next prompt-build。每个节点用手绘矩形框，箭头形成闭环。旁边标注 typed memory files、MEMORY.md、learned skills。风格简洁、清晰、工程图、浅色背景。
-->

## 文件原生存储

MemFlywheel 的真实数据源是记忆根目录下的 Markdown 文件。`MEMORY.md` 只是系统根据这些文件重建出来的索引。

```text
memory-root/
  MEMORY.md

  identity/*.md
  preference/*.md
  style/*.md
  workflow/*.md
  context/*.md
  ambient/*.md

  .memflywheel/
    sources/*.jsonl
    index/*

skills-root/
  memflywheel-learned-*/SKILL.md
```

这些目录是默认记忆分类，接入方可以根据自己的项目、用户或业务域调整分类粒度。

| 路径 | 作用 |
|---|---|
| `identity/*.md` | 长期身份和稳定事实 |
| `preference/*.md` | 用户偏好 |
| `style/*.md` | 表达风格和协作风格 |
| `workflow/*.md` | 工作流经验 |
| `context/*.md` | 当前上下文，默认 30 天后提示验证 |
| `ambient/*.md` | 背景性事实，默认 30 天后提示验证 |
| `MEMORY.md` | 派生索引，可重建，不是事实源 |
| `.memflywheel/sources/*.jsonl` | 清洗后的原始对话和工具轨迹，用于按需深读 |
| `.memflywheel/index/*` | 索引层检索缓存 |
| `memflywheel-learned-*/SKILL.md` | learned skill 包 |

每个记忆文件由 Markdown 正文和 YAML frontmatter 组成：

```md
---
type: style
name: concise-structured-collaboration
description: The user prefers direct, structured engineering collaboration with clear boundaries and visible tradeoffs.
retrieval_terms:
  - direct answer
  - structured explanation
  - engineering tradeoff
  - ASCII diagram
  - clear boundaries
created_at: 2026-06-24T10:00:00.000Z
updated_at: 2026-06-24T10:00:00.000Z
---

The user prefers concise engineering answers that start with the concrete conclusion before expanding into details. When explaining mechanisms, define the term first, then describe who does what, when it runs, and how it is triggered. For comparisons, tradeoffs, workflows, and architecture, compact tables or ASCII diagrams are preferred over long prose. The user dislikes vague summaries, hidden assumptions, and compatibility patches that obscure the real boundary.

## Sources

- .memflywheel/sources/session-20260624-collaboration.jsonl#L10-L18
- .memflywheel/sources/session-20260624-collaboration.jsonl#L31-L37
```

<!--
IMAGE_PLACEHOLDER: docs/assets/readme/03-file-layout.png
生图提示词:
技术手绘文件树图，展示 memory-root 和 skills-root。memory-root 下有 MEMORY.md、identity、preference、style、workflow、context、ambient、.memflywheel/sources、.memflywheel/index。skills-root 下有 memflywheel-learned-*/SKILL.md。用文件夹和文档小图标，白板手绘风，简洁清晰，少量颜色强调 MEMORY.md、sources 和 learned skills。
-->

## 渐进召回与索引层预召回

MemFlywheel 不把所有记忆正文塞进 prompt。它先注入索引线索，让主业务 Agent 自己决定是否继续读取完整记忆文件。

```text
User query / current task
        |
        v
MEMORY.md index records
        |
        +-- small index -> inject full MEMORY.md cues
        |
        +-- large index -> embedding + BM25 + RRF over index lines
                         -> inject topN relevant paths
        |
        v
Main Agent reads selected *.md files
        |
        v
If body is not enough, read .memflywheel/sources/*.jsonl line ranges
```

预召回只作用在 `MEMORY.md` 索引层：

| 字段 | 是否参与预召回 |
|---|---|
| `name` | 是 |
| `description` | 是 |
| `occurred_on` | 是 |
| `retrieval_terms` | 是 |
| `type` / `path` | 少量参与稀疏路由 |
| memory body 正文 | 否 |
| `.memflywheel/sources` 原始轨迹 | 否 |

这样做的目标是让 上下文 保持轻量，同时保留三层渐进读取能力：

```text
Layer 1: MEMORY.md index cues
        |
Layer 2: selected memory Markdown body
        |
Layer 3: source trace JSONL line ranges
```

<!--
IMAGE_PLACEHOLDER: docs/assets/readme/04-progressive-recall.png
生图提示词:
技术手绘分层图，标题 Progressive Recall。三层从上到下: MEMORY.md index cues、selected memory .md body、.memflywheel/sources JSONL traces。左侧有 user query，先进入 index pre-retrieval，经过 embedding + BM25 + RRF，只选 top paths。右侧标注 host agent uses its own Read/Grep tools。浅色背景，黑色线条，少量蓝绿强调。
-->

## 学习飞轮

MemFlywheel 不只保存事实记忆，也会把反复出现的可执行流程沉淀成 learned skills。一次执行结束后，记忆提取先沉淀事实与轨迹，技能进化再把稳定流程整理成技能；技能变化会反向触发 dream，把冗余流程细节压缩成指向技能的记忆线索。下一轮任务开始时，主 Agent 同时看到相关记忆和技能路由，用过之后又产生新的轨迹，继续进入下一次提取、学习和整理，从而形成飞轮效应。

```text
Real task execution
        |
        v
Conversation + tool trajectory
        |
        v
memory extraction
        |
        +-- facts / preferences / project rules
        +-- failure lessons / workflow evidence
        |
        v
skill learning gate
        |
        v
skill evolution agent
        |
        +-- create / update / merge / noop learned skills
        |
        v
memflywheel-learned-*/SKILL.md
        |
        v
dream coordination
        |
        +-- compress redundant workflow memory
        +-- leave skill cues in related memories
        |
        v
next prompt-build
        |
        +-- memory index cues
        +-- learned-skill routes
        |
        v
Main Agent reuses memory + skill
        |
        v
better execution, new evidence
        |
        +--------------------------------+
        |                                |
        +------ back to extraction -------+
```



<!--
IMAGE_PLACEHOLDER: docs/assets/readme/05-skill-flywheel.png
生图提示词:
技术手绘飞轮图，环形箭头包含 Memory、Recall、Repeated Workflow、Learned Skill、Dream Compression、Better Memory。中心写 MemFlywheel。旁边放一个 SKILL.md 文件卡片和几个 Markdown memory 文件卡片。表达记忆和技能互相增强的闭环。白板手绘风，简洁，不要营销海报感。
-->

## 包结构

| Package | 作用 |
|---|---|
| `@memflywheel/core` | 文件存储、frontmatter、索引、召回、提取和 dream 工具、隐私、锁、审计 |
| `@memflywheel/model` | provider-neutral tool-calling model 协议和 OpenAI-compatible mapper |
| `@memflywheel/sdk` | 生命周期 hooks，extraction / dream / skill loop 编排 |
| `@memflywheel/skills` | learned skill 文件包、staging、校验、finalize、rollback、召回路由 |
| `@memflywheel/adapters` | Pi、Hermes、OpenClaw、OpenCode、Claude Code、Codex 等宿主生命周期映射 |

## 当前接入状态

MemFlywheel 已经把宿主接入抽象成 SDK hooks、HostHarnessPort 和 adapters。当前真正打通最深的是 Pi；其他宿主已有 adapter/marker，但是否能跑完整记忆与技能闭环，取决于宿主是否暴露生命周期、结构化 tool-call model 通道和工具轨迹。

| Host | 当前进度 | 说明 |
|---|---|---|
| Pi | 已实现完整优先路径 | 已有 Pi adapter、Pi HarnessPort、生命周期映射和 canonical model 映射，可承载 recall、extraction、dream、skill loop |
| Hermes | 已有 adapter 接入骨架 | 需要 Hermes plugin 暴露 `completeWithTools` 一类结构化模型能力后，才能跑写侧闭环 |
| OpenClaw | 已有 recall-first adapter | 当前主要是记忆注入路径；原生 extraction / dream / skill loop 还需要接入 OpenClaw 的模型端口 |
| OpenCode | 已有 recall-first adapter | 当前适合 hook-native recall；没有 host-owned tool-call model port 前，不声明完整写侧闭环 |

## Pi 接入示例

Pi 集成不是让 MemFlywheel 自己接管模型，而是把 Pi 的 lifecycle 和 tool-calling model 通道映射成 `HostHarnessPort`。仓库里的真实入口是 `examples/pi/extension.mjs`：

```js
import { completeSimple } from "@earendil-works/pi-ai";
import { createMemFlywheelHarnessRuntime, createPiHarnessPort } from "@memflywheel/adapters";

/** @param {any} pi - the Pi ExtensionAPI */
export default function memFlywheelExtension(pi) {
  const port = createPiHarnessPort(pi, { completeSimple });
  const runtime = createMemFlywheelHarnessRuntime({ port });

  if (typeof pi.onDispose === "function") pi.onDispose(runtime.dispose);
  return runtime.dispose;
}
```

本地 smoke test：

```sh
pnpm -r build
USE_FAKE=1 node examples/pi/run.mjs
```

模型接入原则：

| 场景 | 做法 |
|---|---|
| 宿主已有模型通道 | 把宿主的结构化 tool-call completion 映射成 canonical model，传给 extraction / dream / skill loop |
| 本地示例或 benchmark | 可以用 `@memflywheel/model` 的 OpenAI-compatible mapper 连接外部模型 |
| core | 不读取 API key，不持有模型服务，不做模型路由 |

## 开发

```sh
pnpm install
pnpm build
pnpm test
pnpm run ci
```

## 开源边界

MemFlywheel 的目标是成为 Agent Harness 里的长期记忆和技能学习基础组件。它保持文件原生、模型无关、宿主优先，不把主 Agent、模型服务、工具权限或技能执行吞进自己内部。
