# MemFlywheel

让 Agent 把每一次执行，沉淀成下一次更懂你的开始。

MemFlywheel 是面向 AI Agent Harness 的文件原生长期记忆与技能学习层，把偏好、工具轨迹、项目约定、失败教训和重复工作流，变成可检查、可 diff、可复用的 Markdown 记忆与 learned skills。

![MemFlywheel overview](docs/assets/readme/01-overview.png)

## 为什么需要 MemFlywheel

多数 Agent memory 方案把记忆放进 memory store、向量库或知识图谱，再靠检索或上下文注入复用。MemFlywheel 则以文件、agent-native 优先策略，用索引、记忆正文、原始轨迹和 learned skills 逐层披露记忆，把偏好、失败教训和可复用流程沉淀为可审计、可迁移、可演化的文件资产。

| 对比维度 | 常见 memory 方案 | MemFlywheel |
|---|---|---|
| 关注点 | 记忆存储、搜索召回、上下文注入 | 执行经验沉淀、证据追溯、技能演化 |
| 记忆对象 | 对话、偏好、知识片段 | 偏好理解、项目约定、工具轨迹、失败教训、重复流程 |
| 存储形态 | API、向量库、知识图谱、框架内 Store | Markdown memories、`MEMORY.md`、`.memflywheel/sources`、learned skills |
| 召回方式 | 检索相关片段后注入 prompt | 索引线索 → 记忆正文 → 原始轨迹 → learned skill |
| 学习闭环 | 通常聚焦“记忆能否被召回” | 重复流程沉淀为 learned skill，并反向整理长期记忆 |
| 工程治理 | 依赖服务或框架内部状态 | 文件可读、可 diff、可归档、索引可重建 |

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


## LoCoMo 评测位置

在 LoCoMo Cat1/2/4 评测上，MemFlywheel 当前取得 `81.23%` LLM-judge score，token-F1 为 `65.93%`。本次使用本地 `bge-m3` embedding，answer/judge 模型为 DeepSeek V4 Flash。

下面只保留 LoCoMo 相关且有论文、官方 benchmark 页或官方仓库支撑的项目。

| 系统 | 公开结果 | 来源 / 实践 |
|---|---:|---|
| [LoCoMo](https://github.com/snap-research/locomo) | benchmark | 官方 ACL 2024 benchmark；用于长对话记忆 QA / summary / multimodal-dialog 评测 |
| [Mem0](https://github.com/mem0ai/mem0) / [paper](https://arxiv.org/html/2504.19413v1) | 67.13% paper / 92.5% latest | 论文与官方 benchmark 口径不同；实践是多层 memory、fact extraction、vector / graph retrieval |
| [MemMachine](https://github.com/MemMachine/MemMachine) / [paper](https://arxiv.org/abs/2604.04853) | 91.69% | arXiv 2026；保留完整 conversational episodes，做 contextualized retrieval |
| [Honcho](https://github.com/plastic-labs/honcho) / [eval](https://honcho.dev/evals/) | 89.9% | 官方 eval 页；memory agent 服务，建模 user / agent / group 等 peers |
| **MemFlywheel 本次** | qwen/qwen3.7-plus: 87.12%；DeepSeek V4 Flash: 81.23%；GPT-4o-mini: 76.89% | 本地实验；文件原生 memory，Agent 通过索引、正文、source trace 和工具调用完成召回回答 |
| [Memori](https://memorilabs.ai/docs/memori-cloud/benchmark/results/) | 81.95% | 官方 results docs；实践是 semantic triples + conversation summaries |
| [Zep / Graphiti](https://help.getzep.com/graphiti/getting-started/overview) | 75.14%-80.00% | Zep blog / Memori 表口径不同；实践是 temporal knowledge graph，结合 time / semantic / graph retrieval |
| [Memobase](https://github.com/memodb-io/memobase) / [benchmark](https://github.com/memodb-io/memobase/blob/main/docs/experiments/locomo-benchmark/README.md) | 75.78% | 官方 benchmark repo；实践是 user profile + event timeline，面向画像和个性化上下文 |
| [Letta Filesystem](https://www.letta.com/blog/benchmarking-ai-agent-memory/) | 74.00% | Letta blog；实践是把 LoCoMo 对话放进 filesystem，让 agent 用 file search / grep / open 检索 |
| [LangMem](https://langchain-ai.github.io/langmem/) | 58.10%-78.05% | MemMachine / Memori 表口径差异较大；实践是 LangGraph BaseStore + semantic / episodic / procedural memories |
| [MemoryOS](https://github.com/BAI-LAB/MemoryOS) / [paper](https://arxiv.org/html/2506.06326v1) | F1 +49.11% / BLEU-1 +46.18% | EMNLP 2025 Oral；层级 memory OS，short / mid / long-term 动态更新 |
| [A-Mem](https://github.com/agiresearch/A-mem) / [paper](https://arxiv.org/html/2502.12110v11) | LoCoMo F1 / ROUGE-L | 论文 / OpenReview；Zettelkasten 风格动态 note、tag 和 memory linking |
| [SimpleMem](https://github.com/aiming-lab/SimpleMem) / [paper](https://arxiv.org/html/2601.02553v1) | 43.24 F1 | arXiv / project page；semantic structured compression + adaptive query-aware retrieval |

MemFlywheel 是 agent 驱动的记忆系统，最终效果一定程度上依赖 answer/judge 模型以及提取、召回阶段模型的 agentic 能力；同一套文件原生记忆结构，在不同模型下会体现出不同的工具使用、证据定位和综合回答能力。


## 核心流程

![MemFlywheel lifecycle hooks](docs/assets/readme/02-lifecycle.png)

## 文件原生存储

MemFlywheel 的真实数据源是记忆根目录下的 Markdown 文件。`MEMORY.md` 只是系统根据这些文件重建出来的索引。

```text
memory-root/
├─ MEMORY.md
├─ identity/*.md
├─ preference/*.md
├─ style/*.md
├─ workflow/*.md
├─ context/*.md
├─ ambient/*.md
└─ .memflywheel/
   ├─ sources/*.jsonl
   └─ index/*

skills-root/
└─ memflywheel-learned-*/SKILL.md
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

## 渐进召回与索引层预召回

MemFlywheel 不把所有记忆正文塞进 prompt。它先注入索引线索，让主业务 Agent 自己决定是否继续读取完整记忆文件。

```text
●  User query / current task
        │
        ▼
●  MEMORY.md index records
        │
        ├─▸ small index  →  inject full MEMORY.md cues
        ├─▸ large index  →  embedding + BM25 + RRF over index lines
        │                →  inject topN relevant paths
        ▼
●  Main Agent reads selected *.md files
        │
        ▼
●  If body is not enough → read .memflywheel/sources/*.jsonl line ranges
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
  Layer 1  ·  MEMORY.md index cues
     │
     ▼
  Layer 2  ·  selected memory Markdown body
     │
     ▼
  Layer 3  ·  source trace JSONL line ranges
```

## 学习飞轮

![MemFlywheel learning flywheel](docs/assets/readme/05-skill-flywheel.png)

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
