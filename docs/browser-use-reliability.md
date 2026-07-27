# Browser Use 可靠性门禁

Browser Use 的稳定性不以“代码能运行”或“单个演示成功”为准，而以可重复的真实 Chromium 任务、Observe 质量和严格完成证据共同验收。

## Observe 质量报告

`pageContextBuilder` 在完成 DOM 元素、结构化数据和语义集合合并后，调用 `evaluateObservationQuality()` 生成质量报告。报告随 `BrowserObservation.qualityReport` 写入任务 Trace，包含：

- 可交互元素数量、可执行集合项数量；
- 语义集合对可交互元素的覆盖率；
- 重复 elementId 和重复集合项比例；
- 低置信度候选数量；
- 同名菜单缺少父路径、表单字段不完整、表格行信息不完整、动作缺少风险语义等问题；
- 0-100 的综合质量分。

质量报告已经接入 phase 观察门禁，但不会使用单一总分粗暴阻断任务。门禁按当前 phase 检查它真正需要的语义集合：导航需要可执行菜单集合，填表需要表单集合，下载需要动作或表格行集合，点击搜索结果需要对应的结果集合。重复 `elementId`、目标集合无可执行项或置信度过低时会重新观察一次，仍不可靠则停止执行。

## 目标歧义门禁

`TargetResolver` 同时保留第一候选、第二候选和分差。序号、父路径或显式唯一标识可以作为强消歧证据；观察置信度明显更高的候选可以先执行并在校验失败后切换。若候选语义与置信度都接近，Resolver 返回 `blocked`，并把候选分数与拒绝原因写入 Trace，不再用 DOM 顺序猜测。

## 导航动作事务

可能触发页面跳转的动作统一经过 `NavigationCoordinator`。BFCache、异步响应端口关闭等浏览器生命周期事件只表示“动作结果待确认”，不会直接视为业务失败。协调器会同步当前受控标签页，等待目标文档的 content script 可观察，再由 phase verifier 根据 URL、标题、页面状态或目标集合进行最终验收。

`BrowserUseSession` 会在动作前后维护受控标签页快照。结果链接打开新标签页时，按以下顺序接管：

1. 新标签页的 `openerTabId` 指向当前受控标签页；
2. 新标签页 URL 命中 Resolver 提供的目标 `href`；
3. 动作窗口内只出现一个活跃新标签页。

多个候选无法唯一判断时保持在原标签页并报出歧义，不接管无关页面。搜索结果落地验收优先使用实际 URL 与所选结果 `href` 的一致性，其次使用跨 origin 导航和搜索集合消失证据；页面标题包含“搜索”或“搜索结果”不再被单独用作失败依据。

## 页面就绪与目标租约

Runner 不再依赖分散的固定等待时间判断页面是否可操作。`waitForStableBrowserState()` 会按当前 phase 对相关语义集合生成指纹，只有同一状态连续出现后才允许继续；content script 正在重建或标签页刚完成跳转时的瞬时消息错误会被归类为可重试观察，而不是直接结束任务。

Planner 选出的 DOM 目标不会直接执行。Runner 会创建 `BrowserUseTargetLease`，在动作提交前重新观察并再次解析语义目标：

- elementId 变化但文本、链接、父路径和序号仍一致时，租约安全重绑定到新元素；
- “第 N 项”对应的文本或链接已变化时，返回 `TARGET_STALE` 并拒绝点击；
- 多个候选仍无法唯一判断时，返回 `TARGET_AMBIGUOUS`；
- 只有复验通过的目标才进入真实点击、输入或下载动作。

动作完成后再进行稳定观察与独立阶段验收。动作级校验通过但业务目标未达成会归类为 `OUTCOME_NOT_REACHED`，并计入同一 phase 的失败预算，不会无限循环或伪装完成。

当前标准错误分类包括：`OBSERVATION_INCOMPLETE`、`TARGET_AMBIGUOUS`、`TARGET_STALE`、`ACTION_NO_EFFECT`、`PAGE_NOT_SETTLED`、`OUTCOME_NOT_REACHED`、`BLOCKED_BY_AUTH`、`DOWNLOAD_NOT_STARTED` 和 `ACTION_EXECUTION_FAILED`。

## 黄金任务

黄金任务目录位于 `tests/e2e/browserUseGoldenTasks.ts`。每个任务声明：

- 自然语言目标；
- 测试页面与最大步数；
- 期望完成状态；
- 必须经过的 phase；
- 必须观察到的语义集合；
- 业务结果断言。

当前首批覆盖：

1. 同名父菜单下选择正确的叶子菜单并真实导出；
2. 选择筛选项、输入字段、查询并下载第一条表格数据；
3. 导出后进入文件中心，并按下载结果中的文件名打开同一文件；
4. 页面没有导出按钮时必须明确失败，不能伪装完成。

扩展可靠性回归还覆盖 `noopener/noreferrer` 搜索结果：点击指定序号后必须接管目标标签页，并在目标 URL 上完成验收。

## 失败阶段恢复

Browser Use 失败事件携带 `ComputerUseResumeCheckpoint`，其中保留已编译任务计划、当前失败 phase、已完成阶段、下载结果、浏览器会话和阶段输出。Chat 中点击“重试”会把 checkpoint 交回 Runner，从失败阶段继续，而不是从头重复业务操作。

下载文件名会先使用 Chrome downloads API 提供的有效文件名；如果浏览器只暴露临时 UUID，则从 `finalUrl/url` 恢复带扩展名的真实文件名。该名称会作为后续文件中心定位条件。真实 Chromium 回归覆盖：文件中心第一次缺少目标文件而失败，页面恢复后重试只执行 `click_latest_download`，不会重复导航或导出。

单次扩展回归：

```bash
pnpm test:e2e
```

黄金任务连续五轮稳定性门禁：

```bash
pnpm test:browser-use:golden
```

失败时 Playwright 会保留截图、trace、当前 URL、页面文本摘要和黄金任务质量报告。默认产物写入 `test-results/` 与 `playwright-report/`，不提交到 Git。

## 发布门槛

核心任务达到以下条件后，才允许继续扩展新动作或新站点：

- 关键黄金任务连续五轮成功率至少 90%；
- 所有成功任务具备明确 phase 完成证据；
- 不出现“未执行但显示完成”；
- 同名菜单、表单字段和表格行操作可解释地解析到唯一目标；
- 失败 Trace 包含 phase、目标、观察质量、候选和恢复建议。
