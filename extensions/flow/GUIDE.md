# Flow 使用与设计（v1）

Flow 固定的是步骤、数据接口和激活条件。比如一次依赖兼容性检查，可以要求收齐类型检查与集成测试的证据后才能给出结论。**“发现不兼容”是有效的业务结论，不等于工具没能运行。** LDK 不为此实现 Skill，也不把整个流程塞进一条提示词让模型自行遵守。

## 定义与编辑

- **Flow 必须有名**。`/flow`、`/action` 打开选择器和原生多行 JSON 编辑器，也可用 `new 名称`、`edit 名称`、`view 名称`、`list`。编辑即可保存，不生成差异确认；类型或图无效会报错，编辑器保留草稿供纠正。模型通过 `flow_guide`、`flow_inspect`、`flow_define` 操作同一份定义，保存不会运行。
- Action 是静态定义，节点是某处使用它的位置。每次执行产生独立状态；同一定义用两次不会共用输入输出。`global:名称` 在使用同一生效配置目录的会话间共享；`local:名称` 指当前 Flow 的 `actions`；节点内直接填写 `use: { ... }` 是匿名 Action，一个位置一份，复制后独立，保存 Flow 时一并保存。不靠字符串查找优先级猜测同名定义。
- Blank Action (`builtin:action`) 是基础，会话模板负责说明怎样处理显式输入、调用哪些工具、输出什么。内置节点共享它的端口契约，但确定性的传递、判断、分派、收束不需要询问模型。`extends` 可引用内置、全局和本 Flow 的有名定义；全局定义不能反向引用某个 Flow 的私有定义。继承后覆盖的 `inputs`、`outputs` 各自整张替换，不把同名端口隐式合并。
- 两个入口都会显示选中的**配置根目录**。本会话首次使用时，如 Pi 宿主工作目录已有 `.pi/` 就使用它，否则使用 `getAgentDir()`（包括 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`）；选定后本会话内固定，`/reload` 重新选择。根下的 `ldk-flow/flows/`、`ldk-flow/actions/` 分别存普通 JSON 定义。文件名用用户名称的 UTF-8 十六进制编码，避免大小写不敏感的文件系统把两个名称混用。项目 `.pi` 与 Pi 的用户配置目录不是同一个命名空间；没有跨根隐式引用或合并。定义跟会话配置走，不跟随 LDK `/wd` 或嵌入终端 `cd`。不额外设 Flow 信任或授权模式，也不会借 Flow 获取 Pi 未提供的能力。

## 消息和连线

节点可有多个命名输入、多个命名输出。线的两个端点均为 `[节点 ID, 端口名]`。声明例 `{"report":{"type":"object","fields":{"passed":{"type":"boolean"}}}}`；消息包例 `{"report":{"type":"object","value":{"passed":false}}}`。`fields` 中声明的字段必须存在，允许额外 JSON 字段。外层消息必须带具体类型，结构体中的字段则是普通 JSON 值，不再包一层消息。

| 声明类型 | 消息值 |
|---|---|
| `null` | JSON `null`。是已到达的信号；未激活的连线没有消息。 |
| `text` | 字符串，绝不会按内容猜作布尔或文件。 |
| `boolean` | `true` 或 `false`，不是字符串。 |
| `object` | JSON 对象，可预先约定字段及其类型。 |
| `file` | 非空文件路径；相对路径按执行目录解析。传的是路径，不自动读、写或复制文件。 |
| `any` | 只用于声明。实际发送时指定前五种之一，到达下游再按下游声明核验。 |

普通步骤等必需输入齐备，模板返回一个按输出口命名的 JSON 消息包，**不是带 Markdown 围栏的代码块**。声明 `tools: ["read", ...]` 才给该模板提供相应 Pi/LDK 可调用工具，工具仍经过 Pi 正常的验证、钩子和权限管线；不会拼进去主会话完整历史。模板不是在本机求值的 JavaScript。

如果模板最后的文本不是合法 JSON，节点失败，可在 `flow_status` 中看到原因。例如 `invalid; bytes=86; preview=code-fence` 表示回复以代码围栏开头；`empty` 表示没有文本或只有 JSON 空白。`bytes` 是最终文本的 UTF-8 字节数，`preview` 仅是固定的形状标签，不记录回复片段、字段、值或解析器原文。合法 JSON 但端口、字段或类型不匹配仍按契约单独报错。失败不会触发模板或工具自动重试。

## 预设 Action

| `builtin:` 后缀 | 规则 |
|---|---|
| `action` / `task` | 通用空白步骤 / 任务步骤，默认 `in:any → out:any`。无模板时原样传递（一个输入到一个输出，或同名多端口），不调用模型。变换数据或使用工具时填写模板。 |
| `start` | 唯一起点，运行输入对应其**输出口**。默认 `out:null`，无参启动即可发送信号。 |
| `end` | 终点返回其输入包，默认 `in:any`。同一 Flow 可以有互斥的不同结局。 |
| `decision` | 默认判断 `in:boolean`，只发送 `yes:null` 或 `no:null`。可用 `test: "报告.passed"` 读取输入值中的布尔字段；也可以用模板选一个命名输出口。 |
| `fork` | 一个输入复制给声明的各个 worker 输出口，并发启动本组。 |
| `join` | 声明每个 worker 的输入口，收束规则见下节。默认 `out:object`；可用模板处理已固定的记录。 |
| `gate` | `question` 指明需要用户判断的事情。保留待答状态，用户用 `/flow answer 运行ID` 选择批准或拒绝，走 `yes` 或 `no`；Esc 保持等待。没有让模型代答的工具。 |

## 并行收束

`join` 策略包含三个独立设置：

| 字段 | 值 | 含义 |
|---|---|---|
| `waitFor` | `"all"` 或正整数 `n` | 本次 fork 的所有 worker，或先达到计数条件的 n 个不同 worker。数字超过实际 worker 数则不能启动。 |
| `countOn` | `"succeeded"` / `"settled"` | 成功交付约定输出（包括 `false`、`null`），或任意终态（含执行失败和单个 worker 取消）。整个 Flow 被取消不触发收束。 |
| `remaining` | `"cancel"` / `"finish"` | 阈值满足后，请求取消剩余 worker，或允许其自然结束；两者都不延迟下游。取消是协作式，不回滚已经发生的副作用。 |

缺省策略是 `all + succeeded + cancel`。达到阈值时运行器一次性固定采样，不是让模型猜完成度。结果按 **join 输入口名**关联到各 worker；默认 `out.value` 是这些记录的对象，每份有 `status`，成功携带 `outputs`，失败携带原因。模板要挑选、对比或汇总时，收到的是 `{out:{type:"object",value:这些记录}}`。迟到结果可查运行日志，但不追加到快照，更不会触发第二次收束。如果成功阈值已不可能达到，立即报错，不无限等待。

## 可运行示例：两路回执，任意一路结束即可推进

把下面整段保存为 `/flow new 并行回执` 的内容，或交给 `flow_define` 作为 `definition`（`kind: "flow"`，`name: "并行回执"`）。两个 worker 引用同一个 Flow 私有 Action，但各自有独立执行。

```json
{
  "name": "并行回执",
  "actions": {
    "回执": {"extends": "builtin:task", "template": "把输入 in 的原始消息完整复制到输出 out。例如收到 null 信号，返回 {\"out\":{\"type\":\"null\",\"value\":null}}。"}
  },
  "nodes": {
    "start": {"use": "builtin:start"},
    "split": {"use": {"extends": "builtin:fork", "outputs": {"A":{"type":"null"}, "B":{"type":"null"}}}},
    "甲": {"use": "local:回执"}, "乙": {"use": "local:回执"},
    "collect": {"use": {"extends": "builtin:join", "inputs": {"甲":{"type":"any"}, "乙":{"type":"any"}}, "join":{"waitFor":1,"countOn":"settled","remaining":"finish"}}},
    "end": {"use": "builtin:end"}
  },
  "edges": [
    {"from":["start","out"],"to":["split","in"]},
    {"from":["split","A"],"to":["甲","in"]}, {"from":["split","B"],"to":["乙","in"]},
    {"from":["甲","out"],"to":["collect","甲"]}, {"from":["乙","out"],"to":["collect","乙"]},
    {"from":["collect","out"],"to":["end","in"]}
  ]
}
```

再调用 `flow_run {"name":"并行回执"}`。如果只想先试一个完全不调用模型的 Flow，直接保存 `/flow new` 自动提供的 `start → end` 草稿即可。示例中的两份回执则会调用当前模型。

## 运行记录与边界

- `flow_run` 启动时解析并固定节点、继承链、端口、模板、连线和策略，并给快照生成摘要。修改定义只影响下次启动。这个快照不冻结外部文件、模型服务或 Pi 的工具可用性。
- 人工关口将运行停在原位，`flow_run` 返回运行 ID。用户答复后，无工具的步骤可继续；如需调用 Pi 工具，使用 `flow_continue {"id":"原运行 ID"}` 给同一运行接入新的调用上下文。它不能替用户批准，也不会重跑已完成的步骤。对于使用工具且 `remaining:finish` 的流程，下游立即推进，但外层工具可等迟到 worker 收尾再返回，以保留 Pi 的嵌套调用记录。
- `flow_status` / `/flow status` 列本分支运行，指定 ID 可看步骤、关口、输出、迟到结果。`flow_cancel` / `/flow cancel ID` 请求取消运行和在途 worker。`drained:false` 表示还有收尾可能在进行，不应因此重跑外部写操作。
- 状态属于**当前会话分支**；等待期间留在同一 Pi 进程即可答复。切换分支、退出或 reload 会解除旧运行并停止派发。日志保留，但不会在下一进程自动重放中断的文件修改或模型调用。print 模式退出也不会在后台留下服务。
- 此版是有向无环图，不提供任意回跳。并行区域采用显式配对的 `fork → worker → join`；单个 worker 支持普通步骤链，不支持在一组 worker 内再嵌套 fork、跨组接线或从分支中提前 end。编辑时应明确报错，不以等待代替校验。普通步骤仍支持多入多出，互斥条件重新汇合不需要并行 `join`。
