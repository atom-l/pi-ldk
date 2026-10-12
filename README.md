# ldk

一个 [PI package](https://pi.dev/packages)，把若干自定义扩展打包成一个整体分发。

## 包含内容

| 扩展 | 路径 | 说明 |
|---|---|---|
| 会话命令 | `extensions/sessions.ts` | `/session-new`、`/session-list`、`/session-delete`、`/session-delete-all`、`/session-merge` 及对应短别名。 |
| 模型归属 | `extensions/model-attribution.ts` | 给历史中的助手回复打上生成它的 provider/model 标签，避免中途切换模型时把早前的回复误认成自己的。 |
| MCP 适配器 | `extensions/mcp-adapter.ts` | 从 `.pi/mcp-adapter.json` 和 `~/.pi/agent/mcp-adapter.json` 读取 MCP server 配置并注册给 PI。 |
| 图片生成 | `extensions/image-gen/` | `generate_image` 工具及图片模型处理逻辑。 |
| 子会话工作台 | `extensions/session-agents/` | 角色 agent + 子会话(公共桌面)+ 经验记忆的大型任务拆分框架,详见[子会话工作台](#子会话工作台)。 |

## 安装

从远端仓库安装：

```bash
pi install git:github.com/atom-l/pi-ldk
```

可以指定版本 / 分支 / 提交（`git:<repo>@<ref>`）：

```bash
pi install git:github.com/atom-l/pi-ldk@main
```

或者只在单次调用中试用，不写入 settings：

```bash
pi -e git:github.com/atom-l/pi-ldk
```

## 只加载部分扩展

在 PI settings 里可以用对象形式缩小本包加载的资源范围：

```json
{
  "packages": [
    {
      "source": "git:github.com/atom-l/pi-ldk",
      "extensions": ["extensions/sessions.ts", "extensions/image-gen"]
    }
  ]
}
```

- `[]` 表示该类型一个都不加载；
- `!pattern` 表示排除匹配到的 glob；
- `+path` / `-path` 表示精确包含 / 排除某个路径。

例如只需子会话工作台时用 `"extensions": ["extensions/session-agents"]`;
开发调试单个扩展也可以直接按路径加载,不装包:

```bash
pi --extension ./pi-ldk/extensions/session-agents
```

## 子会话工作台

`extensions/session-agents/`,面向"大型任务拆分"场景的三层协作架构:

```
会话模型(调度者)
   │  ① 任务上下文 → 指派进子会话的上下文空间
   ▼
子会话 subsession(公共桌面:任务上下文 + desk + 工作日志)
   │  ② 为子会话指派所需的角色 agent,协作多轮
   ▼
角色 agent(固定上下文 + 专属底层模型 + 各自的知识/视角)
   │  ③ 完成后返回【结果】+【额外信息】
   ▼
经验记忆 insight(跨会话沉淀,类 RAG 快速召回 + 主动启发)
```

核心思想:**任务不直接派给 agent**。任务本身的上下文先进入"子会话"这个
公共的工作台;agent 是带着固定上下文与合适模型的"角色",被指派到子会话里,
在公共桌面(desk)与工作日志上相互交流、协作完成任务。

### 三层概念

#### 1. 角色 agent(`agent_*`)

一个**自带固定上下文的角色**:专属的知识、看待问题的角度、工作风格,以及
为其挑选的底层模型(勘察类用便宜快速的模型,判断类用强模型)。角色不直接
接收任务,只在被指派进子会话时工作。

#### 2. 子会话(`subsession_*`)

agent 们的**公共桌面**。任务上下文(目标、验收、背景数据、约束)指派进它的
上下文空间;被指派的角色在其中协作:

- **desk(公共桌面)**:findings(发现)/ decisions(决策)/ issues(异常) /
  open(待决)/ artifacts(产出)/ notes(备注),agent 用内部工具 `desk_update` 写入;
- **工作日志**:每个 agent 每轮的贡献记录,所有 agent 可见;
- 完成时通过 `subsession_finish` 返回两部分:
  1. **结果**:任务完成情况或结论;
  2. **额外信息**:解决路径、中途遇到的异常与问题、可迁移的经验与启发。

#### 3. 经验记忆(`insight_*`)

结果与额外信息沉淀为跨会话的记忆记录,提供**类 RAG 的召回/回溯**:

- **快**:内存倒排索引 + BM25,无模型调用,毫秒级返回;
- **主动提供启发**:`before_agent_start` 按当前输入自动召回最相关的经验,
  注入系统提示的 `<session_agents_experience>` 段落(不相关自动跳过);
- **可回溯**:每条记录带 kind、来源子会话、角色、时间、项目与命中词项;
- 中英混合分词(拉丁整词 + CJK 一元/二元 gram),支持 kinds / scope / detail 过滤。

### 工具一览

| 工具 | 作用 |
|---|---|
| `agent_create` | 创建角色:name、description、systemPrompt(固定上下文)、model、tools、maxTurns |
| `agent_update` | 修改角色配置或追加固定上下文 |
| `agent_list` | 列出角色、子会话、可选模型清单 |
| `agent_discard` | 丢弃角色(单个 / 全部) |
| `subsession_create` | 创建子会话:task(目标与验收)、context(任务上下文)、assignments(指派角色)、synthesisModel |
| `subsession_run` | 跑一轮协作:参与的角色依次工作(desk 写入 + 贡献),返回本轮摘要与桌面状态 |
| `subsession_finish` | 收尾合成,返回【结果】+【额外信息】,并沉淀经验到记忆 |
| `subsession_get` | 查看子会话:summary / desk / log / result |
| `subsession_discard` | 丢弃子会话(单个 / 全部) |
| `insight_recall` | 类 RAG 检索历史结果与额外信息(query / kinds / limit / scope / detail) |
| `insight_add` | 主动记录一条经验 |

另有内部工具 `desk_update`(exposure: deferred),仅供子会话内的 agent 写公共桌面。

### 典型流程(模型侧)

```
agent_create  name="explorer" model="ksyun/deepseek-v4.1-flash"
              systemPrompt="你是勘察角色:关注事实与边界情况,结论必须带依据……"
agent_create  name="critic" model="anthropic/claude-sonnet-4-5"
              systemPrompt="你是挑剔的评审角色:关注风险、漏洞与异常……"

subsession_create name="auth-refactor" title="鉴权重构"
                  task="把 session 鉴权迁移到 OAuth,给出结论与风险"
                  context="<背景资料、目录结构、约束>"
                  assignments=[{agent:"explorer",focus:"现状勘察",lead:true},
                               {agent:"critic",focus:"风险评审"}]

subsession_run  name="auth-refactor" instruction="完成各自分工,把发现写上桌面"
subsession_run  name="auth-refactor" instruction="基于桌面共识,给出方案草案" agents=["critic"]
subsession_finish name="auth-refactor"
# → 返回【结果】+【额外信息】,并沉淀经验

insight_recall  query="OAuth 迁移 风险"      # 后续任务需要时召回
```

多张子会话可以并行派发(同一条消息里多次 `subsession_run`);同一子会话内的
轮次自动串行。

### 返回格式(`subsession_finish`)

```
# 子会话 "auth-refactor" — 鉴权重构

## 结果 (result)
<任务完成情况或结论:完整、可独立使用>

## 额外信息 (extras)
### 解决路径
### 异常与问题
### 经验与启发

(已沉淀 N 条经验到跨会话记忆;后续任务可调用 insight_recall 召回)
```

### 生命周期与持久化

| 数据 | 生命周期 | 存储 |
|---|---|---|
| 角色、子会话(desk/log/结果) | 与会话相同 | 会话 custom entry(不进模型上下文),resume / 分支切换后重放恢复 |
| 经验记忆 | **跨会话** | `~/.pi/agent/session-agents/insights.jsonl` |

模型可随时 `agent_discard` / `subsession_discard` 主动释放;子会话被丢弃后,
其已沉淀的经验仍可通过 `insight_recall` 召回。

### 实测记录

1. 端到端:2 角色 → 子会话 → 协作轮(desk 写入)→ finish 返回【结果】+【额外信息】✅
2. `insight_recall` 召回上一会话沉淀的经验(BM25 排序 + 出处 + 命中词项)✅
3. 新任务自动注入 `<session_agents_experience>` 且被模型主动引用 ✅
4. 会话 resume 后角色 / 子会话(desk、log、assignments、usage、结果)完整恢复 ✅
5. 协作 agent 反向发现并已修复的缺陷:`appendEntry` 引用别名污染操作日志
   (persist 前 `structuredClone`)、`desk_update` 不落盘(新增 `sub_desk` op)、
   角色统计恢复归零(新增 `role_stats` op)✅

### 限制与说明

- agent 单条工具结果注入历史时截断到 32 KB;单次工具结果返回给调用模型
  截断到 48 KB(完整内容保留在子会话工作日志中)。
- 子会话工作日志超过 80 条时自动裁剪旧条目(保留最近 60 条)。
- 经验记忆按项目 cwd 隔离(`scope:"all"` 可跨项目检索);记忆文件只追加,
  可手动清理或用 `subsession_discard` 控制沉淀节奏。
- 授予角色工具时注意权限:嵌套工具调用与模型调用走同样的权限钩子,但
  也可以授予 `agent_create` / `subsession_*` 让角色自行再拆解任务(无深度
  上限,请自行控制)。
- 合成(subsession_finish)使用:子会话 synthesisModel > lead 角色的模型 >
  会话模型。

## 说明

- 扩展所需的 PI 宿主包通过 `peerDependencies` 提供（`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`），**不要**把它们挪进 `dependencies`。
- 扩展以与 PI 相同的操作系统权限运行，能访问文件、凭证和会话历史；安装第三方来源前请先审阅源码。
