# Background 模块

Background 是 Chrome Extension Service Worker 的运行时入口。`index.ts` 只做依赖装配和监听注册。

| 目录 | 职责 |
| --- | --- |
| `handlers` | Chrome runtime 消息解析与请求分发。 |
| `browserUse/planning` | 目标理解、任务计划和阶段规划。 |
| `browserUse/observation` | 标签页观察、页面上下文和语义集合。 |
| `browserUse/resolution` | 将语义目标解析为可执行页面目标。 |
| `browserUse/actions` | 原子动作、标签页动作和下载执行。 |
| `browserUse/verification` | 动作校验与阶段完成判定。 |
| `browserUse/runtime` | Runner、会话、检查点、轨迹和运行状态。 |
| `browserUse/messaging` | 浏览器消息通道错误的归类与恢复。 |
| `tasks` | 统一任务运行时、执行器注册和页面监控。 |
| `model` | Background-only 模型网关与模型客户端。 |
| `ocr` | OCR Job 生命周期和 Offscreen 调度。 |
| `business` | Background 业务工具编排辅助逻辑。 |
| `maintenance` | 版本升级、废弃数据清理等一次性维护逻辑。 |

新增 Browser Use 文件时，应先判断属于“计划、观察、解析、动作、校验、运行时”中的哪一层，不直接放到 `browserUse` 根目录。
