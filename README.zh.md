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
  <a href="https://www.npmjs.com/package/@memflywheel/core"><img alt="npm" src="https://img.shields.io/npm/v/%40memflywheel%2Fcore?label=npm"></a>
  <a href="https://www.npmjs.com/package/@memflywheel/core"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40memflywheel%2Fcore?label=downloads"></a>
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
    <td><strong>宿主原生</strong><br>当前已支持 Pi，后续计划接入更多 Agent Harness。</td>
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

安装 Pi package：

```sh
pi install npm:@memflywheel/adapters
```

Pi 会读取 `@memflywheel/adapters` 声明的 extension，并通过原生 lifecycle 驱动
MemFlywheel 完成 prompt-build 召回、turn-end 提取、source trace 和文件原生记忆写入。源码调试和 smoke test 放在
[`docs/integrations.md`](docs/integrations.md)。

## 包结构

| Package                                                                        | 作用                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| [`@memflywheel/core`](https://www.npmjs.com/package/@memflywheel/core)         | 存储、frontmatter、索引、召回、提取/dream 工具、隐私、锁、审计      |
| [`@memflywheel/model`](https://www.npmjs.com/package/@memflywheel/model)       | provider-neutral tool-calling model 协议和 OpenAI-compatible mapper |
| [`@memflywheel/sdk`](https://www.npmjs.com/package/@memflywheel/sdk)           | 生命周期 hooks，extraction / dream / skill-loop 编排                |
| [`@memflywheel/skills`](https://www.npmjs.com/package/@memflywheel/skills)     | learned skill 包、staging、校验、finalize、rollback、召回路由       |
| [`@memflywheel/adapters`](https://www.npmjs.com/package/@memflywheel/adapters) | 当前已接入 Pi，后续计划接入更多 Agent Harness                       |

## 评测

MemFlywheel 使用面向 LoCoMo 的回归检查，让长期记忆能力在召回、提取和 learned skill 闭环演进时可衡量。详见
[`docs/extraction-regression.md`](docs/extraction-regression.md) 和
[`docs/dream-regression.md`](docs/dream-regression.md)。

## 文档

| 文档                                                               | 内容                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------ |
| [`docs/architecture.md`](docs/architecture.md)                     | 存储布局、召回、提取、dream、技能闭环、包边界          |
| [`docs/integrations.md`](docs/integrations.md)                     | Pi package 安装、SDK hooks、adapter 边界、宿主能力分级 |
| [`docs/extraction-regression.md`](docs/extraction-regression.md)   | 提取子代理真实模型回归报告                             |
| [`docs/dream-regression.md`](docs/dream-regression.md)             | Dream 整合子代理真实模型回归报告                       |
| [`docs/release.md`](docs/release.md)                               | 版本规范、npm 发布渠道、发布检查清单                   |
| [`NOTICE`](NOTICE)、[`THIRD_PARTY_LICENSES`](THIRD_PARTY_LICENSES) | 项目版权告知和三方 license 披露                        |

## 开源边界

MemFlywheel 的目标是成为 Agent Harness 里的长期记忆和技能学习基础组件。它保持文件原生、模型无关、宿主优先，不把主 Agent、模型服务、工具权限或技能执行吞进自己内部。
