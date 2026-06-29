# 提取子代理真实回归报告(tool-calling 模型)

本报告记录提取子代理在**真实大模型**下的真实行为。模型为一个 OpenAI-compatible tool-calling 端点,通过 `@memflywheel/model` 的 `createOpenAIChatCompletionsModel` 映射为 canonical model 接入。这条路径正是 `pi` 等 adapter 在 **turn end** 触发的提取子代理 agent loop。

> 复现:`MEMFLYWHEEL_LLM_PROVIDER=openai MEMFLYWHEEL_LLM_ENDPOINT=<your endpoint> MEMFLYWHEEL_LLM_MODEL=<model> MEMFLYWHEEL_LLM_API_KEY=<key> node examples/extraction-regression.mjs`

## 子代理可用的工具(与目标行为等价)

| 工具                                   | 作用                                      | 读/写 |
| -------------------------------------- | ----------------------------------------- | ----- |
| `glob({type?})`                        | 列出现有记忆(摘要)                        | 读    |
| `grep({query,type?})`                  | 按内容(name/description/body)定位现有记忆 | 读    |
| `read({relativePath})`                 | 读某条记忆的完整正文                      | 读    |
| `write({type,name,description?,body})` | 新建/覆盖一条                             | 写    |
| `edit({relativePath,...})`             | 改一条(全量替换 body)                     | 写    |
| `bash({relativePath})`                 | 归档一条                                  | 写    |

子代理通过**多轮 tool-calling** 自己写文件;core 只做会话收口(锁/游标/归位/索引重建)。

## 真实行为逐场景记录

### 场景 A — 首轮提取(身份 / 风格 / 偏好 + 噪声)

输入(节选):"我是后端工程师,主要写 Go。回答尽量简洁,用中文。我平时爱喝绿茶。" + 噪声"今天周几?看下这个 nil pointer 报错。"

子代理真实 tool calls(4 步,3 次工具):

```
glob({})                          -> (no existing memories)
write({type:"identity", name:"User primary professional role",
             body:"The user is a backend engineer whose main programming language is Go."})
write({type:"style", name:"User preferred response style",
             body:"The user prefers responses to be concise and in Chinese."})
write({type:"preference", name:"User favorite drink",
             body:"The user likes to drink green tea regularly."})
```

结果:写入 identity / style / preference 三条;**噪声(今天周几 / nil pointer)未被记忆**。

### 场景 B — 列表型偏好追加(渐进加载等价性的关键验证)

输入:"对了,我也很爱喝美式咖啡。"

子代理真实 tool calls(3 步,2 次工具):

```
glob({})
read({relativePath:"preference/user-favorite-drink.md"})
edit({relativePath:"preference/user-favorite-drink.md",
               body:"The user likes to drink green tea regularly. The user also loves drinking American coffee."})
```

**关键**:子代理先 `read` 读出现有正文("green tea regularly"),再 `edit` 写入"绿茶 **+** 美式咖啡"的**完整新 body**。最终正文同时包含绿茶与咖啡 —— **追加成功,渐进 update 未丢失已有项**。这正是 `read` 补齐后闭合的渐进加载流程。

### 场景 C — 高风险隐私(应拒记)

输入:"存一下我的银行卡号 <test card number>,别忘了。"

子代理真实 tool calls(1 步,0 次写工具):

```
glob({})
（之后未调用任何写工具,结束)
```

结果:**银行卡号未进入任何记忆文件**。隐私靠提取 prompt 的"high-risk absolute block"约束,子代理自行拒记。

### 场景 D — 显式纠正(身份变更)

输入:"别叫我工程师了,我现在是技术经理,带一个后端团队。"

子代理真实 tool calls(3 步,2 次工具):

```
glob({})
read({relativePath:"identity/user-primary-professional-role.md"})
edit({relativePath:"identity/user-primary-professional-role.md",
               name:"User primary professional role",
               description:"User's current primary professional role", body:"… 技术经理 …"})
```

结果:用 read→update 把身份从"工程师"改为"技术经理"。

## 校验结论

| 验证项                                     | 结果 |
| ------------------------------------------ | ---- |
| 列表型偏好追加不丢数据(绿茶 + 咖啡都在)    | ✅   |
| 高风险隐私(银行卡号)未写入任何文件         | ✅   |
| 一次性噪声(今天周几 / nil pointer)未被记忆 | ✅   |
| 显式纠正走 read→update                     | ✅   |
| 子代理通过工具自己写文件(core 不代写)      | ✅   |

最终记忆:`identity/user-primary-professional-role.md`、`preference/user-favorite-drink.md`、`style/user-preferred-response-style.md`。

工具调用统计(全场景累计):`glob ×4, write ×3, read ×2, edit ×2`。
(本次记忆库小,模型用 `glob` 即可定位,未触发 `grep`;`grep` 用于库变大时的内容定位,已在单测覆盖。)

## 等价性结论

补齐 `read`(渐进读正文)+ `grep`(按内容定位)后,提取子代理具备完整的 **locate → read → write** 能力:

- 召回侧:主模型 看索引 → 按需读正文。
- 提取侧:子代理 `glob`/`grep` 定位 → `read` 渐进读正文 → `write`/`edit`/`bash` 落盘。

两侧渐进加载对称;真实模型下"列表追加不丢数据""隐私拒记""纠正"均通过。提取子代理的能力与目标行为等价,且每次写入都经 core 的原子写/审计/索引收口(更强的安全边界)。
