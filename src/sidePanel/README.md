# SidePanel 模块

SidePanel 是用户主入口，只负责交互、即时状态和结果呈现。

- `components/Chat/hooks`：会话、AI 请求、命令、任务事件和专题研究编排。
- `components/Chat/browserUse`：Browser Use 任务卡和轨迹展示。
- `components/Chat/research`：页面感知问答、专题升级和来源展示。
- `components/Tools`：资料、Memory、命令、健康检查和自动化入口。
- `utils/chat`：聊天消息状态和命令定义。
- `utils/documents`：资料问答路由与文件上下文。
- `utils/runtime`：运行时保护、健康检查和基础请求。
- `utils/auth`：登录相关的 SidePanel 辅助逻辑。
- `utils/integrations`：钉钉等外部集成。

禁止在 SidePanel 内新增模型网络客户端或 OCR 引擎。长任务必须交给 Background，SidePanel 只订阅进度并渲染结果。
