# 源码目录说明

`src` 按“扩展运行入口 + 领域模块”组织。入口文件保持稳定，业务实现放入对应领域目录，避免再次形成大平层。

## 目录结构

```text
src/
├── background/       # Service Worker：模型、任务、Browser Use、OCR 与消息路由
├── content/          # 注入业务网页的页面观察、动作执行与选区入口
├── dashboard/        # 独立工作台：任务中心、模型设置与工作流编辑器
├── offscreen/        # 不依赖 SidePanel 生命周期的 OCR Host
├── sandbox/          # PaddleOCR 受限运行环境
├── shared/           # 跨运行上下文共享的契约、仓储和纯业务逻辑
├── sidePanel/        # 用户主界面：Chat、工具箱、登录与结果卡片
└── test/             # 通用测试辅助代码
```

## 放置规则

1. `index.ts`、`index.tsx` 和 `App.tsx` 只负责启动、装配或路由，不承载领域逻辑。
2. Background 新能力先判断属于 `browserUse`、`tasks`、`model`、`ocr`、`business` 还是 `handlers`，不得直接堆到 `src/background`。
3. 跨入口使用的类型和纯逻辑放入 `shared/<domain>`；仅供某个入口使用的实现留在该入口内部。
4. 测试与被测模块同目录，使用 `<name>.test.ts(x)` 命名。
5. UI hooks、卡片和领域逻辑分开存放，不把异步编排继续写入大型页面组件。
6. 不为方便引用创建包含副作用的 barrel 文件；跨领域依赖使用明确模块路径。
7. 新目录应拥有单一职责。若一个目录超过约 20 个实现文件，应继续按子领域拆分。

## 依赖方向

```text
sidePanel / dashboard / background / content
                    ↓
                  shared
```

- `shared` 不得依赖任何具体 UI 或扩展入口。
- `content` 不得直接访问 SidePanel 状态。
- SidePanel 不直接调用模型网络或 OCR runtime，只通过 Background 任务和消息接口。
- Background 的领域模块不得反向依赖 SidePanel 或 Dashboard。
