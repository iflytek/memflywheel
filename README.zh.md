# MemFlywheel

<p align="center">
  <img src="docs/assets/brand/memflywheel-icon.png" alt="MemFlywheel icon" width="104" height="104">
</p>

<p align="center">
  <strong>MemFlywheel</strong><br>
  <span>让 Agent 把每一次执行，沉淀成下一次更懂你的开始！</span>
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@iflytekopensource/adapters"><img alt="npm" src="https://img.shields.io/npm/v/%40iflytekopensource%2Fadapters?label=npm"></a>
  <a href="https://www.npmjs.com/package/@iflytekopensource/adapters"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40iflytekopensource%2Fadapters?label=downloads"></a>
  <a href="https://github.com/iflytek/memflywheel/releases"><img alt="release" src="https://img.shields.io/github/v/release/iflytek/memflywheel?include_prereleases&label=release"></a>
  <a href="https://github.com/iflytek/memflywheel/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/iflytek/memflywheel/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.13.0-339933">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/iflytek/memflywheel"></a>
</p>

![MemFlywheel overview](docs/assets/readme/01-overview.png)

MemFlywheel 给 Agent Harness 增加一层文件原生记忆飞轮：执行前召回，执行后沉淀，重复工作流演化为 learned skills。

<table>
  <tr>
    <td><strong>文件原生</strong><br>Markdown 记忆、source trace 和 learned skills 可检查、可 diff。</td>
    <td><strong>渐进召回</strong><br>从预召回到索引线索、记忆正文和证据逐层读取。</td>
  </tr>
  <tr>
    <td><strong>执行后学习</strong><br>turn-end 提取和 dream 整理让记忆持续流动。</td>
    <td><strong>宿主原生</strong><br>Pi、Hermes、OpenCode 和 OpenClaw 均通过 npm 包接入。</td>
  </tr>
</table>

## 为什么需要

给你的 Agent 装上记忆飞轮：行动前先想起，执行后会沉淀，每一次运行都更懂你。宿主 Agent Harness 管生命周期、模型、鉴权和工具；MemFlywheel 管记忆与学习闭环。

## 如何工作

```text
Agent Harness
   |
   |  lifecycle / model / auth / tools
   v
MemFlywheel
   |
   |-- pre-recall       -> MEMORY.md 索引线索
   |-- progressive read -> 记忆正文 -> source trace -> learned skills
   |-- turn-end         -> 长期记忆提取
   |-- idle             -> dream 整理与修复
   `-- repeated work    -> 可复用 learned skills
```

<table>
  <tr>
    <td width="50%"><img src="docs/assets/readme/02-lifecycle.png" alt="MemFlywheel lifecycle"></td>
    <td width="50%"><img src="docs/assets/readme/05-skill-flywheel.png" alt="MemFlywheel skill flywheel"></td>
  </tr>
  <tr>
    <td><strong>记忆生命周期</strong><br>召回、提取、整理和证据回溯都围绕文件原生记忆仓库展开。</td>
    <td><strong>技能飞轮</strong><br>重复工作流会演化成 Agent 可检查、可复用的 learned skills。</td>
  </tr>
</table>

## 快速开始

Pi：

```sh
pi install npm:@iflytekopensource/adapters
```

Hermes：

```sh
npm install -g @iflytekopensource/hermes
memflywheel-hermes-install
hermes config set memory.provider memflywheel
```

OpenCode：

```sh
opencode plugin @iflytekopensource/adapters --global
opencode run --dir /path/to/project "你的任务"
```

OpenClaw：

```sh
openclaw plugins install npm:@iflytekopensource/adapters
openclaw config set plugins.slots.memory memflywheel
openclaw config set plugins.entries.memflywheel.hooks.allowConversationAccess true
openclaw config set plugins.entries.memflywheel.hooks.allowPromptInjection true
openclaw gateway run --force
```

MemFlywheel 会作为原生记忆插件接入各宿主。宿主继续负责模型、工具、权限和会话；MemFlywheel 补上召回、
turn-end 提取、dream 整理和 learned skills。

embedding 预召回是可选项。不配置也能正常使用，MemFlywheel 会直接注入最多 200 行生成的
`MEMORY.md` 索引。记忆索引继续增长后，先启动任意 OpenAI-compatible embeddings endpoint，再在启动宿主前导出这些变量；预召回会自动生效，只注入最相关的索引条目。

```sh
export MEMFLYWHEEL_EMBEDDING_ENDPOINT="https://embedding-gateway.example.com/v1"
export MEMFLYWHEEL_EMBEDDING_API_KEY="..."
export MEMFLYWHEEL_EMBEDDING_MODEL="text-embedding-3-small"
```

宿主配置、embedding 预召回、验证命令和排查路径见 [`docs/integrations.md`](docs/integrations.md)。

## 安装包

| Package                                                                                    | 作用                                                            |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| [`@iflytekopensource/adapters`](https://www.npmjs.com/package/@iflytekopensource/adapters) | Pi、OpenCode、OpenClaw，以及 Hermes bridge 复用的宿主适配运行层 |
| [`@iflytekopensource/hermes`](https://www.npmjs.com/package/@iflytekopensource/hermes)     | Hermes MemoryProvider 安装器和 skill 镜像                       |

内部 workspace 包按职责拆代码；普通用户只安装自己宿主需要的包。

## 评测

MemFlywheel 使用面向 LoCoMo 的回归检查，让长期记忆能力在召回、提取和 learned skill 闭环演进时可衡量。详见
[`docs/evaluation.md`](docs/evaluation.md)。

## 文档

| 文档                                                               | 内容                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)                     | 存储布局、召回、提取、dream、技能闭环、包边界                             |
| [`docs/integrations.md`](docs/integrations.md)                     | Pi、Hermes、OpenCode、OpenClaw、embedding 预召回、SDK hooks、adapter 边界 |
| [`docs/evaluation.md`](docs/evaluation.md)                         | LoCoMo 定位和本地回归检查                                                 |
| [`docs/release.md`](docs/release.md)                               | 版本规范、npm 发布渠道、发布检查清单                                      |
| [`CHANGELOG.md`](CHANGELOG.md)                                     | 公开 npm 包版本变更记录                                                   |
| [`NOTICE`](NOTICE)、[`THIRD_PARTY_LICENSES`](THIRD_PARTY_LICENSES) | 项目版权告知和三方 license 披露                                           |

## 开源边界

MemFlywheel 的目标是成为 Agent Harness 里的长期记忆和技能学习基础组件。它保持文件原生、模型无关、宿主优先，不把主 Agent、模型服务、工具权限或技能执行吞进自己内部。

## 💬 社区交流

欢迎加入 Astron 开源交流群（企业微信），与我们交流与合作：

<img src="https://github.com/iflytek/astron-agent/raw/main/docs/imgs/WeCom_Group.png" alt="加入 Astron 开源交流群" width="300" />
