# 甘草 Copilot 架构图

当前项目是一个 Manifest V3 Chrome 扩展。Vite 打包 4 个运行入口：

- `sidePanel.js`: 插件侧边栏，承载登录、聊天、文件上传、资料中心、OCR 和工具箱。
- `dashboard.js`: 自动化工作台，承载工作流列表、工作流编辑器、流程图和运行日志。
- `background.js`: 扩展后台模块化服务工作线程，是消息路由、AI 编排、页面工具网关、自动化执行、下载入库和资料工具中心。
- `content.js`: 注入业务页面，负责页面观察、DOM 动作执行、搜索结果提取、控制台错误采集、选中文本入口和页面登录态同步。

## 总体架构图

这张图只表达主调用链：用户从入口层发起动作，所有请求先进入后台中枢，再分发到能力层，最后落到页面执行、本地数据或外部服务。细节模块放在后面的专项图里。

```mermaid
flowchart LR
  User["用户"]

  subgraph Entry["入口层"]
    SidePanel["侧边栏<br/>聊天 / 附件 / OCR / 工具箱 / 任务轨迹"]
    Dashboard["自动化工作台<br/>工作流编辑 / 流程图 / 运行日志"]
  end

  subgraph Hub["后台中枢"]
    Background["background/index.ts<br/>统一消息路由 / 权限 / 标签页控制"]
  end

  subgraph Capability["能力层"]
    ChatAI["AI 对话与工具调用"]
    BrowserAuto["浏览器自动化<br/>固定工作流 / 智能操作"]
    DocCenter["资料中心<br/>解析 / OCR / 检索 / 结果"]
    Diagnostics["页面诊断与登录态同步"]
  end

  subgraph RuntimeData["执行与数据层"]
    Content["content.js + content/tools.ts<br/>观察页面 / 执行动作 / 提取数据"]
    ChromeStorage["chrome.storage.local<br/>登录态 / 上传文件兼容数据 / 工作流 / 草稿"]
    IndexedDB["IndexedDB: gancao_document_center<br/>assets / assetContents / chunks / results / rawFiles"]
  end

  subgraph External["外部服务"]
    LLM["DeepSeek / 86GameStore<br/>对话 / 规划 / 任务拆解"]
    DingTalk["钉钉 OAuth / 甘草 SSO"]
    WebPage["业务网页<br/>DOM / 控制台 / 页面存储"]
  end

  User --> SidePanel
  User --> Dashboard

  SidePanel <-->|"运行时消息"| Background
  Dashboard <-->|"运行时消息"| Background

  Background --> ChatAI
  Background --> BrowserAuto
  Background --> DocCenter
  Background --> Diagnostics

  ChatAI --> LLM
  ChatAI --> DocCenter
  ChatAI --> Content

  BrowserAuto --> Content
  BrowserAuto --> DocCenter
  BrowserAuto --> ChromeStorage

  DocCenter --> IndexedDB
  DocCenter --> ChromeStorage

  Diagnostics --> Content
  Diagnostics --> ChromeStorage
  Diagnostics --> DingTalk

  Content --> WebPage
  SidePanel --> ChromeStorage
  Dashboard --> ChromeStorage
  SidePanel --> IndexedDB
```

## 后台核心模块图

```mermaid
flowchart LR
  BG["background/index.ts<br/>统一消息入口"]
  GLM["AI 对话客户端<br/>glm-client.ts"]
  Gateway["业务工具网关<br/>handleBusinessTool"]
  Auto["固定工作流<br/>automation.ts"]
  CU["智能浏览器操作<br/>computerUseRunner.ts"]
  Intent["意图理解<br/>computerUseIntent.ts"]
  Planner["规划器<br/>computerUsePlanner.ts"]
  Context["页面上下文<br/>pageContextBuilder.ts"]
  Verify["步骤校验<br/>verifyComputerUseStep.ts"]
  Download["下载入库<br/>downloadManager.ts"]
  Trace["任务轨迹<br/>computerUseTrace.ts"]
  DB["资料库<br/>documentDb.ts"]
  Content["内容脚本工具<br/>content/tools.ts"]

  BG --> GLM
  BG --> Gateway
  BG --> Auto
  BG --> CU
  Gateway --> DB
  Gateway --> Content
  Auto --> Content
  Auto --> CU
  CU --> Intent
  CU --> Context
  CU --> Planner
  CU --> Content
  CU --> Verify
  CU --> Download
  CU --> Trace
  Download --> DB
```

## 智能浏览器操作闭环

```mermaid
flowchart LR
  Start["侧边栏或工作流发起<br/>RUN_COMPUTER_USE / computerTask"]
  Router["后台 runComputerUseOnTab<br/>创建 runId / AbortController / 初始轨迹"]
  Parser["快速任务解析<br/>computerUseTaskParser.ts<br/>识别搜索起始 URL 等"]
  SearchSkill["搜索引擎专项技能<br/>computerUseSkills/searchEngineSkill.ts"]
  Intent["意图理解<br/>computerUseIntent.ts<br/>任务类型 / 目标实体 / 期望输出 / 风险"]
  Context["页面上下文构建<br/>pageContextBuilder.ts<br/>观察页面 / 结构化数据 / 表格 / 导航候选"]
  Planner["规划器<br/>computerUsePlanner.ts<br/>规则优先 + 大模型兜底"]
  Act["动作执行<br/>content tools 或 downloadManager<br/>点击 / 输入 / 提取表格 / 下载文件"]
  Verify["步骤校验<br/>verifyComputerUseStep.ts<br/>URL / 文本 / 元素 / 表格 / 下载结果"]
  Trace["轨迹记录<br/>computerUseTrace.ts<br/>观察 / 计划 / 动作 / 结果 / 错误"]
  UI["侧边栏任务卡片<br/>日志 / 复制 / 重试 / 高风险确认"]

  Start --> Router
  Router --> Parser
  Parser -->|"搜索型任务"| SearchSkill
  Parser -->|"普通任务"| Intent
  Intent --> Context
  Context --> Planner
  Planner --> Act
  Act --> Verify
  Verify -->|"成功，继续或完成"| Context
  Verify -->|"失败，可恢复"| Context
  Verify -->|"阻塞或连续失败"| Trace
  SearchSkill --> Trace
  Act --> Trace
  Router --> Trace
  Trace --> UI
  UI -->|"确认高风险动作"| Router
```

## 聊天与工具调用流程

```mermaid
sequenceDiagram
  actor User as 用户
  participant Chat as 侧边栏聊天
  participant BG as 后台服务
  participant AI as AI 对话客户端
  participant Tool as 业务工具网关
  participant CS as 内容脚本
  participant DB as 资料中心

  User->>Chat: 输入问题 / 上传资料 / 发起诊断
  Chat->>BG: SEND_MESSAGE(messageHistory)
  BG->>AI: 流式对话请求 + BUSINESS_TOOLS
  AI-->>BG: 增量回答
  BG-->>Chat: SSE_MESSAGE / SSE_STATUS_CHANGE
  AI->>BG: 工具调用请求
  BG->>Tool: EXECUTE_TOOL(toolName, arguments)
  alt 页面类工具
    Tool->>CS: EXECUTE_BROWSER_TOOL
    CS-->>Tool: 页面观察 / 搜索结果 / 表格 / 动作结果
  else 资料类工具
    Tool->>DB: 列出 / 读取 / 检索 / 总结 / 对比 / 拆任务
    DB-->>Tool: 资料 / 分块 / 结果
  else 任务轨迹
    Tool->>BG: get_task_trace
    BG-->>Tool: 最近自动操作日志
  end
  Tool-->>BG: 工具结果
  BG->>AI: 追加工具结果继续生成
  BG-->>Chat: 最终回答
```

## 资料中心数据流

```mermaid
flowchart TB
  Upload["用户上传 / 粘贴文件"]
  LocalParse["本地解析<br/>shared/fileParser.ts<br/>Excel / Word / PDF / 文本 / 表格"]
  RawFile["原始文件保存<br/>rawFiles"]
  OCR["OCR 识别<br/>sidePanel/utils/ocrEngine.ts<br/>Tesseract + pdfjs"]
  OCRStruct["OCR 结构化<br/>shared/ocrStructurer.ts<br/>字段 / 表格 / 正文区块 / 摘要"]
  WebCapture["网页结构化采集<br/>extract_page_structured_data"]
  Download["浏览器导出下载<br/>downloadManager.ts<br/>chrome.downloads 监听"]
  Store["资料库访问层<br/>documentStore.ts / documentDb.ts<br/>同一套 IndexedDB 结构"]
  Chunk["文档分块与评分<br/>shared/documentChunker.ts"]
  Tools["资料工具<br/>list/read/search/summarize/compare/generate tasks/export"]
  Results["资料结果<br/>需求任务清单 / 网页结构化数据 / 表格结果"]

  Upload --> LocalParse
  Upload --> RawFile
  RawFile --> OCR
  OCR --> OCRStruct
  Download --> LocalParse
  WebCapture --> Store
  LocalParse --> Store
  OCRStruct --> Store
  Store --> Chunk
  Chunk --> Store
  Store --> Tools
  Tools --> Results
  Results --> Store
```

## 自动化工作流流程

```mermaid
flowchart LR
  Editor["工作台编辑器<br/>WorkflowEditor / WorkflowGraph"]
  Storage["chrome.storage.local<br/>automationWorkflows"]
  BG["后台服务<br/>RUN_AUTOMATION"]
  Runner["AutomationRunner<br/>顺序执行固定步骤"]
  Browser["页面工具集<br/>导航 / 点击 / 输入 / 等待 / 提取 / 截图"]
  ComputerTask["computerTask 步骤<br/>复用智能浏览器操作子系统"]
  Events["运行事件<br/>AUTOMATION_PROGRESS / FINISHED / ERROR"]
  UI["工作台或侧边栏日志"]

  Editor -->|"保存 / 加载"| Storage
  Editor -->|"运行工作流"| BG
  BG --> Runner
  Runner --> Browser
  Runner --> ComputerTask
  ComputerTask --> Browser
  Runner --> Events
  Events --> UI
```

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `src/sidePanel` | 用户主入口：登录、聊天、附件解析、结构化 OCR、资料中心入口、工具箱、智能操作任务卡片。 |
| `src/dashboard` | 工作流增删改查、可视化编排、固定流程运行控制和运行日志展示。 |
| `src/background/index.ts` | 插件核心编排：运行时消息、权限、标签页控制、AI 客户端、工具路由、自动化调度、下载入库、登录态同步。 |
| `src/background/computerUse*.ts` | 智能浏览器操作子系统：意图理解、页面上下文、规则/LLM 规划、执行结果校验、轨迹记录。 |
| `src/background/downloadManager.ts` | 真实导出/下载动作：监听 `chrome.downloads`，尝试读取下载内容，解析后保存到资料中心。 |
| `src/content` | 页面侧执行层：DOM 观察、元素语义识别、搜索结果提取、浏览器动作、页面结构化提取、控制台错误缓存、登录态读取。 |
| `src/shared` | 跨入口共享类型、业务工具声明、文件解析、文档分块、OCR 结构化、Computer Use 结果汇总、导出器。 |
| `src/sidePanel/utils/documentStore.ts` 与 `src/background/documentDb.ts` | 两套入口各自访问同一个 `gancao_document_center` IndexedDB，用于资料、内容、分块、结果和原始文件。 |
| `public` | Manifest、HTML 壳、钉钉登录脚本、页面控制台桥接脚本。 |

## 架构备注

- `background/index.ts` 仍是最核心的编排点，但 Computer Use 已经拆成多个独立模块，执行链路比上一版更清晰。
- `content/tools.ts` 现在不只是执行动作，还会给元素打上 `purpose`、`region`、`context`、`score`，供智能操作规划使用。
- 自动操作结果会进入内存轨迹 `computerUseTrace.ts`，侧边栏再以任务卡片形式展示、复制和重试。
- 下载文件不再只是点击按钮：`download_file` 会等待真实下载事件，并尽量把下载文件解析后写入资料中心。
- 资料中心同时接收上传文件、OCR 结构化结果、网页结构化采集和下载文件；最终统一走文档分块与检索工具。
- 当前聊天附件上下文以本地解析文本、表格和 OCR 为主；代码里仍保留大模型文件上传工具，但侧边栏当前标记为跳过原生文件上传。
