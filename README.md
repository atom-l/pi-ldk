# ldk

一个 [PI package](https://pi.dev/packages)，把若干自定义扩展打包成一个整体分发。

## 包含内容

| 扩展 | 路径 | 说明 |
|---|---|---|
| 会话命令 | `extensions/sessions.ts` | `/session-new`、`/session-list`、`/session-delete`、`/session-delete-all`、`/session-merge` 及对应短别名。 |
| 模型归属 | `extensions/model-attribution.ts` | 给历史中的助手回复打上生成它的 provider/model 标签，避免中途切换模型时把早前的回复误认成自己的。 |
| MCP 适配器 | `extensions/mcp-adapter.ts` | 从 `.pi/mcp-adapter.json` 和 `~/.pi/agent/mcp-adapter.json` 读取 MCP server 配置并注册给 PI。 |
| 图片生成 | `extensions/image-gen/` | `generate_image` 工具及图片模型处理逻辑。 |

## 安装

从本地路径安装：

```bash
pi install ./pi-ldk
```

或者只在单次调用中试用，不写入 settings：

```bash
pi -e ./pi-ldk
```

发布后可从 npm / git 安装：

```bash
pi install npm:ldk@0.1.0
pi install git:github.com/<owner>/ldk@v0.1.0
```

## 只加载部分扩展

在 PI settings 里可以用对象形式缩小本包加载的资源范围：

```json
{
  "packages": [
    {
      "source": "./pi-ldk",
      "extensions": ["extensions/sessions.ts", "extensions/image-gen"]
    }
  ]
}
```

- `[]` 表示该类型一个都不加载；
- `!pattern` 表示排除匹配到的 glob；
- `+path` / `-path` 表示精确包含 / 排除某个路径。

## 说明

- 扩展所需的 PI 宿主包通过 `peerDependencies` 提供（`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`），**不要**把它们挪进 `dependencies`。
- 扩展以与 PI 相同的操作系统权限运行，能访问文件、凭证和会话历史；安装第三方来源前请先审阅源码。