# MemScribe 项目概览

## 一句话定位

MemScribe 是一个**文件型长期记忆运行层**:把一套文件型长期记忆方案做成可被其他 Agent 产品直接集成的开源库。TypeScript-first、纯 Node、零运行时依赖,通过 **adapter + MCP** 接入各家 Agent。它**不是**托管记忆 API、向量数据库或通用 RAG 平台。它自带一份高质量的**默认提取器**,给一个 API key 即可开箱提取。

## 核心理念

1. **文件即事实源**:每条记忆是 Markdown 正文 + YAML frontmatter;`MEMORY.md` 是可随时重建的派生索引,从不由 LLM 编写。
2. **全索引注入 + 主模型自选**:召回不做检索/排序,而是把全部记忆的索引注入,由主模型自己判断相关性、自己决定读哪条正文。**没有 BM25、没有实体索引、没有向量/embedding、没有 top-k**。
3. **宿主生命周期优先**:写入和召回由宿主的 session/turn 生命周期驱动,不依赖 Agent 自觉调用工具。
4. **核心永不调 LLM**:提取和整理需要的 LLM 能力,通过**可插拔注入点**外置;核心只做确定性的校验、存储、索引、审计,并自带默认提取/整理的 prompt 常量与解析函数(不发起任何网络调用)。

## 整体架构

pnpm workspace,5 个包,零运行时依赖(仅 TypeScript/@types/node 为 devDep):

| 包 | 职责 | 规模 |
| --- | --- | --- |
| `@memscribe/core` | 记忆内核:存储/索引/召回/提取/整理/隐私/锁/审计 | 16 源文件 |
| `@memscribe/sdk` | 宿主生命周期集成层 + 两个 LLM 注入点 | 1 源文件 |
| `@memscribe/mcp-server` | stdio MCP server(通用 Agent 工具入口) | 4 源文件 |
| `@memscribe/cli` | 本地安装与治理命令 | 1 源文件 |
| `@memscribe/adapters` | 各宿主生命周期映射 | 10 源文件 |

依赖关系:`sdk → core`,`mcp-server/cli → core (+sdk)`,`adapters → sdk`。

### core 内部模块

`paths`(根解析,`MEMSCRIBE_HOME`/OS data dir)、`frontmatter`(手写解析/序列化)、`storage`(原子写+隐私+时间戳)、`scan`(mtime 倒序、上限 200)、`index-file`(`MEMORY.md` 生成/截断/老化)、`recall`(两段注入)、`extract`(校验 + runExtraction 生命周期)、`dream`(consolidation plan/apply)、`privacy`、`lock`、`atomic`、`audit`、`health`。

## 记忆模型

**frontmatter 只保留最小字段**:

```yaml
name: 显示名
description: 一句话描述
type: preference        # 六类之一
created_at: 2026-06-15T...
updated_at: 2026-06-15T...
```

- **六种类型**:`identity` / `preference` / `style` / `workflow` / `context` / `ambient`,各自一个目录。
- **老化**:`context`、`ambient` 超 30 天会在索引里加"建议验证"提示;其余永久。
- **派生索引**:`MEMORY.md`(给模型读的索引,200 行 / 25KB 截断,**相对路径**),可删可重建。
- **无 scope**:全局单库,不设 user/project/workspace 三级作用域。

## 三大流程

### 召回(recall)
`buildContext` 产出**两段注入**:
1. **稳定规则**(进 systemPrompt,前缀稳定、缓存友好):一段固定的中文 prompt——召回规则 / 保存规则 / 禁止事项 / "不要暴露记忆机制"。
2. **动态前导**(每轮注入):`MEMORY.md` 全索引,用 `<system-reminder>` 包裹。

主模型据此自选,需要细节时才 `Read` 具体文件。

### 提取(extract)
- 默认在 **turn end** 触发(after-turn):锁 → 游标窗口 → 跑提取子代理(子代理用写工具直接落盘)→ 索引同步 → 推进游标。
- **核心不调 LLM**:注入点是 `ExtractionAgentRunner`;核心把记忆工具(`glob` / `grep` / `read` / `write` / `edit` / `bash`,均绑定在持有的写锁内)、对话窗口、现有记忆 manifest 交给它,子代理多轮自主调工具直接写文件,返回 `{ changed }`。可用自带默认子代理(`createExtractionAgentRunner({ model })` + `@memscribe/model` canonical model),也可宿主自供;没配就显式 recall-only 或构造失败。
- 冲突:子代理可先 `glob` 再决定 add 还是 update;仅在用户显式纠正时 `bash` 旧记忆、写新记忆。

### 整理(dream)
- idle/scheduled 的 consolidation,不是普通总结:health / type / path / duplicate / conflict / compress。
- 确定性结构预处理先行(删除正文完全相同的重复、把放错目录的文件搬迁回声明类型,无 LLM);随后由 `dreamRunner`(`DreamAgentRunner`,tool-calling 子代理)读全文后用记忆工具(`glob` / `grep` / `read` / `write` / `edit` / `bash`)直接整理落盘——工具调用本身即改动,无 JSON ops、无 parser;每步原子写 + 审计。不再有 frontmatter 稳定化那一套(工具自带校验,且 `edit` 默认保留 frontmatter)。

## 安全与可靠性

- **并发**:per-root 写锁 + 临时文件原子写(rename)+ append-only 审计日志。
- **隐私**:`<private>…</private>` 始终脱敏为 `[REDACTED]`;明显 secret(token/password/api key/cookie/ssh key)可通过 `refuseSecrets` 硬闸门拒写(MCP 默认开启,core/SDK/CLI 默认关闭)。
- **无静默降级**:写入/索引/审计失败显式暴露。

## 接入方式

| 入口 | 形态 | 说明 |
| --- | --- | --- |
| **MCP** | stdio server | prompt `memscribe.with_memory`;resources `memscribe://index|manifest`;工具为受控普通文件工具 `read/write/edit/bash/glob/grep`,执行层仍强制记忆路径、frontmatter、隐私和索引规则 |
| **SDK** | `createMemScribe(config)` | 生命周期 hooks:`onSessionStart` / `onPromptBuild` / `onTurnEnd` / `onSessionEnd` / `onAgentEnd` / `onIdle`;两个注入点 `agent`(ExtractionAgentRunner)、`dreamRunner`(DreamAgentRunner) |
| **CLI** | `memscribe <cmd>` | `init` / `list` / `read` / `context` / `write` / `doctor` / `rebuild-index` / `dream plan|apply` / `mcp` |
| **adapters** | 宿主生命周期映射 | `hermes` / `opencode` / `openclaw` / `pi` / `codex` / `claude-code`,install 走 plan/apply + 真 round-trip verify |

## 工程现状(2026-06-15)

- **5 包 build 全过,测试全绿**(core / sdk / adapters / mcp-server / cli)。
- **零运行时依赖**。
- 自带默认提取子代理与默认 dream 整理子代理(两者共用同一 canonical model 通道,默认系统提示在 core,工厂 `createExtractionAgentRunner` / `createDreamAgentRunner` 在 sdk,OpenAI-compatible mapper 在 `@memscribe/model`),宿主可直接注入自身模型能力。
- OpenClaw / Hermes / Pi 三家直接集成示例见 `examples/`。
- 设计蓝图见 `docs/BLUEPRINT.md`。

## 刻意不做的(防止重新跑偏)

scope 三级作用域、BM25、实体索引、向量/embedding/top-k、MCP search 工具、frontmatter 额外字段、核心内调用 LLM、运行时 npm 依赖、由 LLM 编写 `MEMORY.md`。

## 开源可移植性取舍

为开源可移植性,两处刻意选择:**索引用相对路径**(非绝对路径)、**根目录用 `MEMSCRIBE_HOME`/OS data dir**(纯 Node,不依赖任何桌面框架的 app data 路径)。
