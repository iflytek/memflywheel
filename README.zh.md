# MemFlywheel

让 Agent 把每一次执行，沉淀成下一次更懂你的开始。

MemFlywheel 是面向 AI Agent Harness 的文件原生长期记忆与技能学习层，把偏好、工具轨迹、项目约定、失败教训和重复工作流，变成可检查、可 diff、可复用的 Markdown 记忆与 learned skills。

![MemFlywheel overview](docs/assets/readme/01-overview.png)

## 为什么需要

多数 Agent memory 方案把记忆放进 memory store、向量库或知识图谱，再靠检索或上下文注入复用。MemFlywheel 把真实数据源留在文件里，让 Agent 逐层读取索引线索、记忆正文、原始轨迹和 learned skills。

```text
Agent run
   │
   ├─ prompt-build  -> 召回 MEMORY.md 索引线索
   ├─ turn-end      -> 从本轮执行提取长期记忆
   ├─ idle          -> 整理、合并、修复记忆仓库
   └─ repeated work -> 演化 learned skills
```

## 提供什么

| 领域 | MemFlywheel 做什么 |
|---|---|
| 存储 | Markdown memories + YAML frontmatter |
| 索引 | 可重建的 `MEMORY.md`，不由模型直接维护 |
| 召回 | 注入轻量索引线索，主 Agent 自己读取相关文件 |
| 证据 | 保存清洗后的 JSONL source trace，支持回溯 |
| 整理 | dream pass 合并、压缩、归档和修复记忆 |
| 技能 | 把可复用流程沉淀为 `memflywheel-learned-*/SKILL.md` |
| 宿主边界 | core 管文件；宿主管生命周期、模型、鉴权和工具 |

## 快速开始

运行离线 Pi demo：

```sh
pnpm install
pnpm -r build
USE_FAKE=1 node examples/pi/run.mjs
```

这个 demo 会跑 prompt-build 召回、turn-end 提取和文件原生记忆写入，不调用外部模型。

## 包结构

| Package | 作用 |
|---|---|
| `@memflywheel/core` | 存储、frontmatter、索引、召回、提取/dream 工具、隐私、锁、审计 |
| `@memflywheel/model` | provider-neutral tool-calling model 协议和 OpenAI-compatible mapper |
| `@memflywheel/sdk` | 生命周期 hooks，extraction / dream / skill-loop 编排 |
| `@memflywheel/skills` | learned skill 包、staging、校验、finalize、rollback、召回路由 |
| `@memflywheel/adapters` | Pi、Hermes、OpenClaw、OpenCode、Claude Code、Codex 等宿主生命周期映射 |

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | 存储布局、召回、提取、dream、技能闭环、包边界 |
| [`docs/integrations.md`](docs/integrations.md) | SDK hooks、adapter 边界、宿主能力分级 |
| [`docs/evaluation.md`](docs/evaluation.md) | LoCoMo 定位和本地回归检查 |
| [`docs/release.md`](docs/release.md) | 版本规范、npm 发布渠道、发布检查清单 |

## 开发

```sh
pnpm install
pnpm build
pnpm test
pnpm run ci
```

## 开源边界

MemFlywheel 的目标是成为 Agent Harness 里的长期记忆和技能学习基础组件。它保持文件原生、模型无关、宿主优先，不把主 Agent、模型服务、工具权限或技能执行吞进自己内部。
