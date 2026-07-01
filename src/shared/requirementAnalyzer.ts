import type { DocumentAsset, DocumentChunk, RequirementTask, RequirementTaskResult, SourceRef } from './documentTypes';

const TASK_KEYWORDS = ['需要', '支持', '实现', '新增', '优化', '修复', '允许', '提供', '用户可以', '系统应', '必须', '应该'];

function makeId(prefix = 'task'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLine(line: string): string {
  return line.replace(/^[-*•\d.、\s]+/, '').trim();
}

function inferType(text: string): RequirementTask['type'] {
  if (/页面|按钮|前端|交互|弹窗|输入框|展示|UI|列表/.test(text)) return 'frontend';
  if (/接口|服务|后端|数据库|权限|token|登录|存储|同步/.test(text)) return 'backend';
  if (/测试|验收|校验|用例|验证/.test(text)) return 'test';
  if (/设计|视觉|样式|原型/.test(text)) return 'design';
  if (/部署|运维|日志|监控|定时/.test(text)) return 'ops';
  if (/需求|规则|流程|业务/.test(text)) return 'product';
  return 'unknown';
}

function inferPriority(text: string): RequirementTask['priority'] {
  if (/必须|阻塞|核心|登录|支付|安全|P0/i.test(text)) return 'P0';
  if (/重要|应该|主要|默认|P1/i.test(text)) return 'P1';
  if (/可以|建议|优化|后续|P2/i.test(text)) return 'P2';
  return 'P2';
}

function inferModule(text: string): string {
  const match = text.match(/(登录|文件|OCR|网页|任务|导出|自动化|权限|表格|用户|订单|患者|合同|报表)/);
  return match?.[1] || '未分类';
}

function makeSourceRef(asset: DocumentAsset, chunk: DocumentChunk, line: string): SourceRef {
  return {
    documentId: asset.id,
    documentTitle: asset.title,
    chunkId: chunk.id,
    pageNumber: chunk.pageNumber,
    sectionTitle: chunk.sectionTitle,
    excerpt: line.slice(0, 180),
  };
}

export function generateRequirementTaskResult(
  assets: DocumentAsset[],
  chunks: DocumentChunk[]
): RequirementTaskResult {
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const tasks: RequirementTask[] = [];
  const seen = new Set<string>();

  chunks.forEach((chunk) => {
    const asset = assetMap.get(chunk.assetId);
    if (!asset) return;

    const lines = chunk.text
      .split(/\n|。|；|;/)
      .map(normalizeLine)
      .filter((line) => line.length >= 8 && line.length <= 220);

    lines.forEach((line) => {
      if (!TASK_KEYWORDS.some((keyword) => line.includes(keyword))) return;
      const key = line.slice(0, 60);
      if (seen.has(key)) return;
      seen.add(key);

      tasks.push({
        id: makeId(),
        title: line.length > 32 ? `${line.slice(0, 32)}...` : line,
        module: inferModule(line),
        type: inferType(line),
        priority: inferPriority(line),
        description: line,
        acceptanceCriteria: [`完成并验证：${line}`],
        dependencies: [],
        risks: [],
        openQuestions: /可能|待定|确认|是否/.test(line) ? [line] : [],
        sourceRefs: [makeSourceRef(asset, chunk, line)],
      });
    });
  });

  const modules = Array.from(new Set(tasks.map((task) => task.module))).filter(Boolean);
  const documentIds = Array.from(new Set(chunks.map((chunk) => chunk.assetId)));

  return {
    documentIds,
    summary: tasks.length
      ? `共识别 ${tasks.length} 个候选任务，覆盖 ${modules.length || 1} 个模块。`
      : '未识别到明确任务，请补充更具体的需求描述或使用 AI 对话继续拆解。',
    modules,
    tasks,
    milestones: modules.map((module) => `${module} 模块完成需求澄清、开发、测试验收`),
    missingInfo: tasks.length ? ['请确认任务优先级、负责人、排期和接口约束。'] : ['缺少明确的需求动作、验收标准或业务规则。'],
    createdAt: Date.now(),
  };
}
