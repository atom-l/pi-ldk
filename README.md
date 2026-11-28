# ldk

一组可按需加载的 [Pi 扩展](https://pi.dev/packages)：管理会话、编排 Flow、分派角色任务，以及在终端内编辑、提问和运行命令。

## 安装

```bash
pi install git:github.com/atom-l/pi-ldk        # 安装；加 @<tag 或提交> 固定版本，加 @<分支> 跟踪分支
pi -e git:github.com/atom-l/pi-ldk            # 仅本次试用，不改 settings
```

开发和验收基线为 **Pi 1.7.0**。从源码开发时，`npm install` 按 `devDependencies` 安装指定版本；通过 Pi 安装时，五个 `peerDependencies: "*"` 复用宿主提供的包，不另装一套 Pi，也不表示兼容所有版本。扩展以 Pi 进程的系统权限运行，可访问文件、凭证和会话历史；安装前请审阅来源。

### 只加载部分扩展

在 Pi 的 `settings.json` 中用 `packages` 对象筛选。按包内的**入口文件**填写；例如图片扩展用 `extensions/image-gen/index.ts`，仅写目录不会选中它：

```json
{"packages":[{"source":"git:github.com/atom-l/pi-ldk","extensions":["extensions/sessions.ts","extensions/image-gen/index.ts"]}]}
```

`[]` 不加载该类资源；`!pattern` 排除匹配项，`+path` / `-path` 精确包含 / 排除。调试本地扩展示例：`pi -e ./pi-ldk/extensions/session-agents`（从仓库父目录运行）。

## 包含内容

| 功能（源码） | 入口 |
|---|---|
| [会话命令](extensions/sessions.ts) | `/session-new`（`/sn`、`/clear`）**开新会话，不删除已有会话文件，不是清屏**；`/session-list`（`/sl`、`/sessions`）切换会话。 |
| 会话删除与合并 | `/session-delete`（`/sd`、`/sdel`）经确认后删除选中的会话；若选中当前会话，先开新会话，切换被否决则保留原文件。`/session-delete-all`（`/sda`、`/sdel-all`）保留当前会话，确认后永久删除当前会话目录中列出的其他会话文件。`/session-merge`（`/sm`、`/merge`）合并对话转录并请求摘要；`/sm raw` 只合并转录。 |
| [模型归属](extensions/model-attribution.ts) | 在请求副本中标出早先回复的 provider/model，不往旧记录补写标签；若模型在新回复开头复述标签，会清除该前缀。 |
| [MCP 适配器](extensions/mcp-adapter.ts) / [图片生成](extensions/image-gen) | `/mcp-adapter list`、`/imagine list`；[原生与旧配置如何共存](#mcp-和图片配置)。 |
| [Flow](extensions/flow) / [回复表单](extensions/reply-form) | [主会话状态机与旧版流程图](#flow-固定流程)：`/flow`、`/action`、`flow_guide`；[需要用户决定时](#回复表单)：`ask_form`。 |
| [子会话](extensions/session-agents) / [工作目录](extensions/workdir.ts) | [角色协作](#子会话工作台)：`/agent-mode`、`/agent-trace`；[会话范围](#会话工作目录)：`/wd`。 |
| [循环保护](extensions/loop-guard) / [底栏](extensions/styled-footer.ts) | [`/loopguard status`](#循环保护) 查看最近暂停原因；[底栏](#美化底栏)显示路径、用量、模型和状态。 |
| [Markdown 编辑器](extensions/markdown-editor) / [嵌入终端](extensions/terminal) | [`/md`](#markdown-编辑模式) 切换输入模式；[`/term`](#嵌入终端) 打开常驻 shell。 |

<a id="从-014x-升级mcp-和图片配置"></a>

## MCP 和图片配置

**MCP：不必迁移。** 新服务可直接配在 Pi 的 `mcp.json`。适配器仍读全局（默认 `~/.pi/agent/mcp-adapter.json`）和受信项目的 `.pi/mcp-adapter.json`；原生同名条目优先，`-` 与 `_` 视为同名。默认由 Pi 连接并发现工具；适配器顶层 `startupWait: false` 将注册推迟到首轮。旧 `directTools`、数组 `command`、`environment` 以及 `exposure` / `toolExposure` 中的 `codemode-deferred`（按 `codemode` 处理）仍可用。stdio 建议用 `args` 数组，每个参数一项，不要额外包引号。

旧增强均为**逐服务、默认关闭**，只配在 `mcp-adapter.json`：`compat.callProxy` 提供 `mcp_call__服务名`，`compat.usageGuide` 附工具说明，`compat.queryGuard` 检查查询参数。例如：

```json
{"mcpServers":{"docs":{"url":"https://example.com/mcp","compat":{"callProxy":true}}}}
```

代理默认不重试；显式 `retries` 也只对服务端声明只读且非破坏性的工具生效。改适配器配置用 `/mcp-adapter reload`；改原生配置用 `/reload`。

**图片：** `/imagine [提示词]` 按可用模型和配置显示选择器；用 `model=provider/id`、`size=尺寸`、`n=张数` 显式指定参数，`out=目录` 指定输出。`/imagine list`（或 `/imagine models`）列出模型和首选后端。模型用 `generate_image`，编辑已有图片用 `referenceImages`；两个入口都返回实际文件路径，不需要 Code Mode。

- Pi registry 中凭证可用的 `image` 模型无需 `imageGeneration: true`；旧网关、`imageGeneration` 和 `PI_IMAGE_GEN_MODEL` 仍可用。不同提供商模型重名时写完整 `provider/model-id`。项目模型配置只在受信项目读取，不自动改写配置。
- 默认单张优先原生。Pi 1.7.0 的原生 OpenRouter / Radius 图片模型可用 `size=2K` 等分辨率档位（以模型支持为准）；`1024x1024` 等像素尺寸和多张仍用旧 `imageGeneration` 配置，不猜测换算，不把一次多张拆成多次请求。保留已配置的旧传输；旧生成 POST 不跟随重定向，原生失败不换后端重发。
- 默认写 `generated-images/`。相对输出目录不能含 `..`；可用绝对路径。Windows 可用完整盘符（如 `/imagine out="D:\My Pictures\成品" 雪山`）或标准 UNC 路径，不用 `D:成品`。同名文件不覆盖；文件名可能经清理，以返回路径为准。

<!-- ldk:flow-guide:start -->

## Flow 固定流程

**新 Flow 是当前主会话的状态机。** 它保存进度并提醒主模型当前该做什么，不另开会话、不运行 Action 模型，也不自动沿图执行。试用：`/flow new 兼容性检查` → 保存 → `/flow start 兼容性检查`，然后在当前聊天中开始工作。旧版端口图继续使用原执行器，不会自动转换。`flow_guide` 按需返回本节。

### 编写主会话状态机

`mode:"state"` 明确使用新语义。`context` 是作者提供、各步共用的背景（可省略）；`start` 指定起点。`actions` 每项是一个状态：`instruction` 告诉主模型在本步做什么，`exits` 写出各个直接后继和离开条件。也可以用 `use:"全局 Action 精确名"` 代替 `instruction`，引用通过 `/action new` 或 `flow_define` 保存的 `{"mode":"state","instruction":"……"}`；出口仍归当前 Flow。两种格式不能以同名保存互相覆盖。状态 ID 必须唯一；每个状态都须从起点可达，并至少保留一条最终通往完成出口的路径。

```json
{
  "mode":"state", "name":"方案评审", "context":"先和用户对齐范围，再实施具体方案。", "start":"讨论",
  "actions":{
    "讨论":{"instruction":"澄清需求；如信息不足，继续对话。","exits":[
      {"to":"调研","when":"需要补充证据"},
      {"to":"实施","when":"已有可供定稿的具体方案","confirm":true}]},
    "调研":{"instruction":"核实待定事项，将结论带回讨论。","exits":[{"to":"讨论","when":"已查到证据或明确了局限"}]},
    "实施":{"instruction":"只落实此次获批的方案并验证。","exits":[{"to":null,"when":"约定工作和验收已完成"}]}
  }
}
```

- **启动与工作。** `flow_run {"name":"方案评审"}`（不要传 `input`）或 `/flow start 方案评审` 只进入起点。启动时冻结定义和引用的指令。本分支一次只有一个活动状态机；主模型在当前聊天中工作，可停留多轮，不需反复启动、假装流转或把聊天复制进定义。新一轮会提示活动状态；同轮以最近的工具回执为准。工具权限不变。背景、指令和获批方案会进入会话记录，不要写入凭证。
- **推进一条边。** `flow_step` 传 `id`、`revision`、`from`（上一次回执的 `current`）、`to` 和 `reason`。程序校验实例、版本、当前状态和直接后继；普通 `when` 的真假由主模型根据证据判断。无边、过期或重复的申请不能推进。可以显式回退或自环；`to:null` 是需要申请的完成出口，不是进入节点后自动结束。单状态不支持同时激活多条边。
- **需要用户确认的出口。** 对 `confirm:true` 须再传 `proposal`（本次具体方案全文）。只有在 Pi 的 TUI / RPC 对话框中明确批准，本次转换才生效；取消、Esc、无交互界面和普通聊天均不是批准。方案修改后须提交新提议。审批约束的是**流程进度**，不是文件或工具权限；不要在受保护步骤获批前先做工作。
- **查看与结束。** `flow_status` 或 `/flow status [id]` 查看本分支；`flow_cancel` 或 `/flow cancel id` 放弃进度，不撤销已做的工作。重新打开同一已保存会话会恢复进度；`/tree` 按所在分支回放，新建或 fork 到另一会话不会接管原实例。无持久会话（如 `--no-session`）不能跨进程恢复。关掉待确认的窗口不会留下可重用的批准。

### 定义与编辑

- `/flow` 管理命名流程，`/action` 管理全局 Action。均支持 `list`、`view 名称`（只读）、`new 名称`、`edit 名称`、`json 名称`（原始 JSON）。模型用 `flow_inspect` 时，省略 `name` 或传 `"name":""` 列出名称，传清单中的完整名称读取定义。`flow_define` 校验保存，不执行。
- **移除 Flow**：`/flow delete 名称`（省略名称则从列表选择），或由模型调用 `flow_delete {"name":"完整名称"}`。两者都先显示名称与当前配置根，默认取消；只有用户选「移到回收目录」才生效。不会物理删除定义。归档后它不再出现在清单，也不能按名查看或新启动；已有运行按原快照继续，历史和全局 Action 保留。没有批量或免确认模式。
- **手动恢复**：成功时会给出归档文件的完整路径，位于同一配置根的 `ldk-flow/trash/flows/` 下。在没有同名活动定义时，将该 JSON 按**原文件名**放回 `ldk-flow/flows/` 即可；如果该名称已重新使用，不要覆盖。归档不会阻止后来显式创建同名的新定义。保存和归档会检查同名写入冲突；若异常退出后一直提示 `Flow is busy`，先停止使用该配置根的所有写入进程，再移除报错指向的空锁目录，不要清理定义或回收文件。
- `/flow new`、`/action new` 默认编辑状态机和状态 Action；`new-graph` 明确新建旧版端口图或其 Action。编辑已有名称按原格式打开。以下有关端口、模板、并行和关口的说明**只适用于旧版图**。
- 旧图工作台用 `↑` / `↓` 或全屏单击选节点，`Enter` 看详情，`m` 打开菜单；`a` 添加、`e` 改属性、`l` 连线、`x` 断线、`c` 管理本流程的 Action。宽窗图文并排；窄窗折行或线路交叉时，`↳` 标目标、`↰` 标来源。`s` 或 `Ctrl+S` 保存；校验失败保留草稿，不静默覆盖外部修改。
- 节点 `use` 可引用 `builtin:`、`global:`、`local:`（本 Flow 的 `actions`），或内联匿名 Action。自定义 Action 用 `extends` 继承；全局不能引用局部。重写 `inputs` 或 `outputs` 时替换整张端口表。多个节点复用同一定义，各自执行，不共享状态。
- 首次访问定义时，宿主工作目录若已有 `.pi/` 就用它，否则用 `getAgentDir()`（支持 Pi 1.7 的 `--agent-dir` 或 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`）。本会话固定该根，`/reload` 重选。`ldk-flow/flows/`、`ldk-flow/actions/` 存 JSON，文件名是名称的 UTF-8 十六进制编码。定义不跨根合并，不随 `/wd` 或终端 `cd` 移动。

### 消息和连线

`from` 和 `to` 均为 `[节点ID,端口名]`。例如端口声明 `{"report":{"type":"object","fields":{"passed":{"type":"boolean"}}}}` 对应消息包 `{"report":{"type":"object","value":{"passed":false}}}`。`fields` 声明的字段必填，字段值是普通 JSON，允许额外字段。

消息有五种具体类型：`null` 是已到达的信号（未激活则没有消息）；`text` 是字符串；`boolean` 的 `false` 也是有效结果；`object` 是 JSON 对象；`file` 是非空路径，相对执行目录解析，不自动读写文件。第六种 `any` 仅供声明，不是可发送的类型。

普通节点等所需输入齐备。`template` 启动一次私有的多轮模型对话，不是另开一份 Pi 会话文件；只接收显式输入，不导入发起会话的聊天，也不执行模板中的 JavaScript。模板必须返回**纯 JSON 输出消息包**，不加围栏或解释。解析、端口或类型不符会报错，不自动重试。解析诊断中的 `bytes` 是 UTF-8 字节数，`preview=code-fence` 表示以围栏开头，`empty` 表示没有文本或只有 JSON 空白，不回显原文。

### Action 的背景、工具和用户答复

- **端口传必需数据，背景只供参考。** Action 可用 `flow_context_list` 找本次运行中已观察到的节点，`flow_context_read {"nodeId":"基线"}` 查它的输入输出预览、里程碑和工具调用状态，`flow_context_share {"note":"……"}` 留一条发现。只见当前运行，进行中不等于已完成；查阅时的来源节点和内容版本可在运行事件中核对。背景有容量限制，不自动共享私有思考、工具参数或返回全文；需要精确值或等待先后顺序，仍要连端口。不要把凭证写入端口或记要。
- **工具跟随宿主，不再逐 Action 授权。** 普通 Pi/LDK、子会话和 MCP 工具走当前调用的 `executeTool`，保留参数校验、权限钩子和取消信号。工具太多时先用 `flow_tools` 查找，下一轮再用选中工具。`tools` 现在表示必需的工具名称，而非白名单：**升级前倚赖 `tools:["read"]` 或 `tools:[]` 来限制写入的模板，请先复核；需要硬性禁止写入时应限制宿主能力。** Flow 自身的运行控制不用于节点递归调度。
- **直接向发起者提问。** TUI 中 Action 可用 `flow_ask_form` 收集单选、多选或 Markdown 文本；若详情只在某个选择下适用，要在详情题声明 `showIf`。确认后回到原节点；取消不会代填，也不读取主聊天。Pi 标为 `model-only` 的宿主工具不能嵌套执行：Flow 会向主模型返回 `hostRequests`。由主模型按原参数真正调用，再用 `flow_continue {"id":"运行ID","requestId":"请求ID"}` 接回；多个匹配结果须指定 `toolCallId`。不接受模型转述或伪造的工具结果，不要为补回执重复执行有副作用的工具。

### 预设 Action

| `builtin:` 后缀 | 默认端口与行为 |
|---|---|
| `start` / `end` | 唯一起点默认 `out:null`；`flow_run.input` 按起点**输出口**传消息。终点默认 `in:any`，返回输入包，可有互斥终点。 |
| `action` / `task` | `in:any → out:any`。无模板时原样传递（单入单出或同名多口）；变换或使用工具时填模板。 |
| `decision` | `in:boolean`，只发 `yes:null` 或 `no:null`。可用 `test:"report.passed"` 取布尔字段，或用模板选择一个输出口。 |
| `gate` | `in:any`；用 `question` 提问。发起者的 TUI 会直接提示，只有用户选“批准”或“拒绝”才走 `yes:null` 或 `no:null`。默认是暂不决定；`Esc` 保持等待，随后可用 `/flow answer 运行ID` 重开。 |
| `fork` / `join` | fork 把一个输入复制到各 worker 输出口；join 为各 worker 声明输入口，默认发 `out:object`。 |

### 并行收束

`join` 默认为 `all + succeeded + cancel`。自定义 `join` 时写全三个字段：

- `waitFor`：`"all"` 或正整数，按不同 worker 计数，不得超过 worker 数。
- `countOn`：`"succeeded"` 计成功交付；`"settled"` 也计失败和单个 worker 取消。取消整个 Flow 不触发收束；阈值不可达则报错。
- `remaining`：`"cancel"` 请求取消其他 worker（不回滚副作用），`"finish"` 让其自然完成。达到阈值即推进下游，只采样一次。

快照以 **join 输入口名**为键；每条记录有 `status`，成功含 `outputs`，失败含 `error`。默认输出及 join 模板收到的输入均为 `{out:{type:"object",value:快照}}`。迟到结果记日志，不修改快照。

### 旧图示例：两路回执，任意一路结束即可推进

将以下 JSON 粘贴到 `/flow json 并行回执` 并保存；或调用 `flow_define`，设 `kind:"flow"`、`name:"并行回执"`、`definition` 为下列对象。再调用 `flow_run {"name":"并行回执"}`。两个 worker 各自调用模型，终点只收到先结束那一路的记录。

```json
{
  "name":"并行回执",
  "actions":{"回执":{"extends":"builtin:task","template":"把 in 消息原样复制到 out，只返回输出消息包。"}},
  "nodes":{
    "start":{"use":"builtin:start"}, "end":{"use":"builtin:end"},
    "split":{"use":{"extends":"builtin:fork","outputs":{"A":{"type":"null"},"B":{"type":"null"}}}},
    "甲":{"use":"local:回执"}, "乙":{"use":"local:回执"},
    "collect":{"use":{"extends":"builtin:join","inputs":{"甲":{"type":"any"},"乙":{"type":"any"}},"join":{"waitFor":1,"countOn":"settled","remaining":"finish"}}}
  },
  "edges":[
    {"from":["start","out"],"to":["split","in"]},
    {"from":["split","A"],"to":["甲","in"]}, {"from":["split","B"],"to":["乙","in"]},
    {"from":["甲","out"],"to":["collect","甲"]}, {"from":["乙","out"],"to":["collect","乙"]},
    {"from":["collect","out"],"to":["end","in"]}
  ]
}
```

### 运行记录与边界

- 启动时固定定义快照，修改只影响下次运行；不冻结外部文件、模型或工具。仅支持有向无环图。并行区须配对 `fork → worker → join`，worker 可由普通步骤串联，不支持嵌套 fork、跨组连线或提前 end；互斥分支汇合无需 join。
- 关口可先查看完整输入。普通批准在原运行继续；要先与用户讨论就选“暂不决定”，需要由主会话实施、亲验再收尾则选“批准并交回主会话实施”。选择交回会立即记录批准，但不会触发下游，即使下一步是另一个关口或终点也会等待。主会话完成约定工作后，用 `flow_continue {"id":"原运行ID"}` 接回，不要重启。若从备用命令答复，后续需要工具时也用同一命令接回。`remaining:"finish"` 不挡下游，迟到任务需要宿主工具时仍需有效的调用上下文。
- 主聊天折叠时只显示流程状态、待处理事项和结果；展开或进入看板，可按节点查内部调用。由主模型接单后发出的顶层工具仍可能显示原生工具行，宿主权限提示不会被隐藏。在全屏 TUI，运行中和完成后均可点击工具行展开；普通终端用“展开工具输出”（默认 `Ctrl+O`）。`/flow status [运行ID]` 打开看板，`←` / `→` 换节点，`Tab` 切总览，`Esc` 退出。卡片与看板会截取长值，`flow_status` 可读本分支的运行日志和迟到结果；旧日志缺拓扑时不借新定义补图。
- `flow_cancel` 或 `/flow cancel 运行ID` 请求取消。`drained:false` 表示可能仍在收尾，不要据此重做外部写操作。等待中的运行需要同一进程和分支；切换分支、退出或 reload 后日志保留，不自动重放。

<!-- ldk:flow-guide:end -->

## 回复表单

`ask_form` 用单选、多选或文本题收集用户的决定。工具启用时，TUI 引导模型把相关问题合成一份表单，即使单题也优先使用；不是遇到问号就弹窗。任务已明确、可自行查证或已授权判断时不必问；要求手写或在 print / JSON / RPC 模式下则用文字。

| 操作 | 按键 |
|---|---|
| 作答与回改 | 选择题 `↑↓` 移动、`空格` 选中或切换、`退格` 清空；填空题默认用与 `/md` 相同的 Markdown 源码高亮，无须切换主编辑器；`Enter` 换行，`/命令` 是答案文字，不会执行。`Tab` / `Shift+Tab` 换题，末题 `Tab` 或 `Ctrl+P` 预览，`PgUp` / `PgDn` 滚动。 |
| 提交 / 重填 | `Shift+Enter` 发起提交，`Ctrl+R` 发起重填；确认框里 `Enter` 才执行，`Esc` 返回原页。重填恢复默认值并回到首题。 |
| 改为手写 | 作答页或预览页按 `Esc`，不发送表单草稿，回到原输入框。 |

`ask_form` 与 Flow 内的 `flow_ask_form` 都支持条件追问。例如「有建议吗？」用 `id: "has"` 的「是／否」单选，给「请写下建议」加 `"showIf":{"questionId":"has","equals":"是"}`：选「否」直接跳过详情。`required:false` 只是选填，不会隐藏题目。条件按前面可见单选题的选项原文匹配，不猜测题干；无法这样表达时，先问前题，等用户回答后再决定是否追问。

所有可见题都可留空：有默认值就采用，无默认则标为跳过。默认值也参与条件判断，但不代表同意。改选后，隐藏题不计数、不预览、不提交（也不标为跳过）；提交前切回原分支可恢复草稿，整表重填会清除它。已提交的回答会进入会话历史，**不要填写密码或密钥**。

## 子会话工作台

任务交给**子会话**，不是直接交给角色。角色带固定指令、模型和获准使用的工具；子会话保存本次任务的目标、验收条件、共享桌面（发现、决策、问题、产物等）和工作日志。

### 工具一览

| 环节 | 模型工具与要点 |
|---|---|
| 选角色 | `agent_list` 查模型和角色，`agent_create` 建角色，`agent_update` 改配置，`agent_discard` 释放。 |
| 给任务 | `subsession_create` 设置 `task`、`context` 和 `assignments`；`subsession_run` 可多轮工作，角色用 `desk_update` 写共享桌面。 |
| 看进度 | `subsession_get` 查看 `summary` / `desk` / `log` / `result`。用户可展开工具结果或用 `/agent-trace`（`/atrace`）看内部调用记录，trace 不作为正文发给模型。 |
| 收尾 | `subsession_finish` 返回**结果和额外信息**（方法、异常、经验）并沉淀记忆。合成模型优先级：`synthesisModel` → lead 角色模型（没设 lead 则取首个指派角色）→ 会话模型。`subsession_discard` 释放桌面并取消其在途后台作业。 |
| 复用经验 | `insight_recall` 按 `query` 检索，可用 `kinds`、`limit`、`detail` 筛选；`insight_add` 手工记录。相关经验也可在后续任务开始时自动召回，不调用模型检索。 |

### 工作模式

`/agent-mode`（`/amode`）可选择模式，也可直接传 `auto`（默认，按复杂度拆分）、`agent`（积极协作）或 `off`（隐藏并拦截角色和子会话工具，不禁 `insight_*`）。模式显示在底栏，随分支恢复。

`subsession_run` 默认依次执行角色和轮次，并等待结果。三个开关独立：`parallelAgents:true` 并行同轮角色；`concurrentRounds:true` 允许同一子会话多轮重叠；`background:true` 立即返回作业 ID，稍后用 `subsession_probe {"job":"job-1","wait":30}` 收取（`wait` 最多 300 秒）。依赖前一轮发现时保持串行。

### 模型能力评分

`models.json` 的模型条目可加 `"capabilities":{"代码能力":92,"速度":75}`：维度自定、1–100 分；`modelOverrides` 按维度覆盖同名值。`agent_list` 列出能力评分及该模型在 Pi 中支持的 `thinkingLevel`。选档以交付质量优先，不假设每个模型都有 `high` 或 `off`。

`agent_create` / `agent_update` 可指定角色档位。换模型时，旧档位不兼容才需同时换档，或传 `"default"` 清除覆盖。新角色不指定档位时走默认调用方式，不自动继承主会话档位。角色工具续轮沿用该轮档位，不影响主会话、其他角色、最终合成或 `maxTurns`。

### 生命周期与持久化

角色、桌面、工作日志和经验随**当前会话分支**保存与恢复，不是跨会话知识库。丢弃子会话不删除已沉淀的经验；回退不会召回分支点以后的记录。`/session-merge` 不复制经验，删除会话文件也会删除其中的经验。旧版共享 `session-agents/insights.jsonl` 不再读写或自动清理。工具结果、trace 和工作日志有大小限制，不宜当作完整审计存档。

## 会话工作目录

`/workdir`（`/wd`）选择子目录、输入路径或重置；`/wd <路径>` 直接切换。相对路径以当前会话工作目录解析，默认是宿主启动目录。切换随分支保存，底栏显示 `wd:`。它引导模型关注该目录，**不是权限边界，不改变进程 cwd，也不移动宿主的 `.pi` 配置**。新建嵌入终端取它作起点，已有终端的 `cd` 与它相互独立。

## 美化底栏

位置行显示宿主路径、Git 分支和会话名；统计行显示用量、缓存、费用、上下文占比和模型（优先配置的显示名，否则用 ID），推理模型另显思考档位。徽章显示各扩展状态。底栏只改变展示，不切换目录或模型。

## 循环保护

默认开启，不增加模型调用。检查连续无进展的内建工具决策，以及当前回复正文或可见思考块的复读；不因运行时间、压缩率或连续报错次数单独停机。一般先在下一次自然请求中引导，同一模式再次形成才暂停；同一流式块出现持续长段复读时可直接暂停。

只在实际介入时提示位置。补充指令即可继续；去重只折叠发给模型的上下文副本，不改历史、不回滚副作用。`/loopguard status` 看最近原因，`/loopguard restore` 清除去重和检测状态，`/loopguard off` / `/loopguard on` 开关检测；这些子命令都不发送新消息。

## Markdown 编辑模式

新会话默认原生输入。`/md` 切换到随 Pi 主题高亮的 Markdown 源码编辑器，再次执行恢复原编辑器。沿用原生补全、历史、粘贴和滚动，不另设预览区。

- `Enter` 优先选择打开的补全候选；没有候选时，单行有效 Pi 命令直接执行，其余文本换行。
- `Shift+Enter` 发起发送，确认框 `Enter` 才发送，`Esc` 保留草稿。若升级后宿主提交接口不可用，恢复原编辑器并保留草稿，不模拟发送。

## 嵌入终端

`/term`（别名 `/terminal`）打开默认终端 `main`；`/term <名称>` 或 `/term open [名称]` 打开或新建。`new <名称>` 新建，`list` 列状态，`destroy <名称>`（或 `kill`）确认销毁，`help` 查看用法。仅 TUI 可打开面板；这是行式 shell，不是 PTY，不适合 `vim`、`top` 等全屏程序。

| 操作 | 按键 / 行为 |
|---|---|
| 执行、补全 | `Enter` 执行，`↑↓` 查历史；`Tab` 补命令或 shell 当前目录下的路径，多项先补公共前缀，再按列候选。 |
| 看输出 | `PgUp` / `PgDn` 滚动面板；全屏模式支持面板内滚轮。缓冲保留最近 5000 行；`Ctrl+L` 清空可见输出。 |
| 折叠 / 销毁 | `Esc` 折叠，shell 和输出继续；`Ctrl+X` 再按一次确认销毁。`Ctrl+C` 中断也可能使 shell 退出。普通命令完成不关面板；shell 退出则自动关闭，同名重开会新建。 |

会话关闭时清理终端。Unix 向 shell 进程组发信号；Windows 终止 shell 进程，**不保证终止所有后代进程**。Windows `cmd.exe` 按启动代码页读写，不主动改 `chcp`。必要时在启动 Pi 前设置 `PI_TERMINAL_CMD_CODEPAGE=936` 或 `65001` 与实际代码页一致；手动切换后请新建终端。覆盖 `PROMPT` 或 `echo off` 可能使目录跟踪失效。
