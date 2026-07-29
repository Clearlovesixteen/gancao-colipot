# Shared 模块

`shared` 保存可在 Background、Content、SidePanel 和 Dashboard 之间复用的契约、仓储与纯逻辑。

| 目录 | 职责 |
| --- | --- |
| `automation` | 任务、工作流和 Browser Use 结果契约。 |
| `auth` | 页面与插件登录态桥接契约。 |
| `commands` | 自定义命令持久化。 |
| `context` | Page Context Hub、页面信号和页面动作消息。 |
| `documents` | 资料仓储、解析、分块、空间和导出。 |
| `errors` | 统一错误码与用户错误。 |
| `memory` | 会话历史、长期记忆和候选记忆。 |
| `model` | 模型配置和运行时类型。 |
| `monitoring` | 页面监控定义与检查历史。 |
| `ocr` | OCR 结构化与 Paddle runtime 契约。 |
| `runtime` | 扩展运行版本等基础契约。 |
| `tasks` | Task Repository。 |
| `tools` | 跨入口共享的 Business Tool 声明。 |

`shared` 中的代码必须保持 UI 无关，不得 import `sidePanel`、`dashboard`、`background` 或 `content`。
