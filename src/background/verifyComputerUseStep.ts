import type {
  ComputerUsePageContext,
  ComputerUseVerificationResult,
  PlannedStep,
} from '../shared/automationTypes';

function normalizeToolResult(result: any): any {
  if (result?.success === true && result?.result && typeof result.result === 'object') return result.result;
  return result;
}

function pageText(context: ComputerUsePageContext): string {
  return [
    context.observation.title,
    context.observation.url,
    context.pageTextPreview,
    context.observation.elements.map((element) => `${element.text} ${element.value || ''}`).join(' '),
  ].join(' ');
}

function compact(text?: string): string {
  return (text || '').replace(/\s+/g, '').trim();
}

function countActionableElements(context: ComputerUsePageContext): number {
  return context.observation.elements.filter((element) => element.visible && element.enabled).length
    + context.navigationCandidates.length
    + context.actionCandidates.length;
}

function hasTargetActive(context: ComputerUsePageContext, targetText?: string): boolean {
  const target = compact(targetText);
  if (!target) return false;
  return context.observation.elements.some((element) => element.active && compact(`${element.text} ${element.context || ''}`).includes(target));
}

function hasMeaningfulPageChange(before: ComputerUsePageContext, after: ComputerUsePageContext): boolean {
  if (before.observation.url !== after.observation.url) return true;
  if (before.observation.title !== after.observation.title) return true;
  if (before.observation.pageState?.kind !== after.observation.pageState?.kind) return true;
  if (after.observation.pageState?.hasModal && !before.observation.pageState?.hasModal) return true;
  if (countActionableElements(after) > countActionableElements(before)) return true;
  return false;
}

function hasExtractedTable(result: unknown): boolean {
  const data = normalizeToolResult(result);
  const resultTables = Array.isArray(data?.tables) ? data.tables : [];
  return resultTables.length > 0;
}

function observedTargetValue(context: ComputerUsePageContext, step: PlannedStep): string | undefined {
  const targetId = step.target?.elementId;
  const element = targetId
    ? context.observation.elements.find((item) => item.elementId === targetId)
    : undefined;
  if (element?.value !== undefined) return String(element.value);

  const formItems = (context.collections || [])
    .filter((collection) => collection.type === 'form_group')
    .flatMap((collection) => collection.items);
  const item = formItems.find((candidate) => (
    (targetId && candidate.elementId === targetId)
    || (step.target?.selector && candidate.selector === step.target.selector)
    || (step.target?.text && compact(candidate.text) === compact(step.target.text))
  ));
  const value = item?.metadata?.currentValue ?? item?.metadata?.value;
  return value === undefined ? undefined : String(value);
}

function verifyDownloadResult(result: unknown): ComputerUseVerificationResult {
  const data = normalizeToolResult(result);
  if (data?.success === true && data.status === 'completed' && data.savedToDocumentCenter === true) {
    return { success: true };
  }
  if (data?.success === true && data.status === 'partial') {
    return {
      success: true,
      warning: data.error || '文件已下载，但无法自动保存到资料中心。',
    };
  }
  if (data?.success === true && data.status === 'completed') {
    return {
      success: true,
      warning: '文件已下载，但未确认保存到资料中心。',
    };
  }
  return {
    success: false,
    blocking: true,
    reason: data?.error || data?.message || '未捕获到下载完成事件。',
  };
}

export function verifyComputerUseStep(input: {
  step: PlannedStep;
  result: unknown;
  before: ComputerUsePageContext;
  after: ComputerUsePageContext;
}): ComputerUseVerificationResult {
  const { step, result, before, after } = input;

  if (after.observation.pageState?.hasCaptcha) {
    return { success: false, blocking: true, reason: '页面出现验证码/安全验证，需要用户处理。' };
  }
  if (after.observation.pageState?.kind === 'login_page') {
    return { success: false, blocking: true, reason: '页面疑似跳转到登录页，需要用户登录。' };
  }
  if (after.observation.pageState?.kind === 'permission_page' || after.observation.pageState?.hasPermissionDenied) {
    return { success: false, blocking: true, reason: '页面提示权限不足，当前账号可能没有目标功能权限。' };
  }

  if (step.action === 'finish') return { success: true };

  if (step.action === 'extract_table') {
    return hasExtractedTable(result)
      ? { success: true }
      : { success: false, reason: '未提取到有效表格。' };
  }

  if (step.action === 'download_file') {
    return verifyDownloadResult(result);
  }

  if (step.action === 'type') {
    const targetId = step.target?.elementId;
    if (!targetId || !step.value) return { success: true };
    const value = observedTargetValue(after, step);
    return value === step.value
      ? { success: true }
      : { success: false, reason: `输入校验失败，当前值为：${value || '空'}` };
  }

  if (step.verify?.type === 'url_contains') {
    const value = step.verify.value || '';
    return after.observation.url.includes(value)
      ? { success: true }
      : { success: false, reason: `URL 未包含 ${value}` };
  }

  if (step.verify?.type === 'text_exists') {
    const value = step.verify.value || step.target?.text || '';
    return !value || pageText(after).includes(value)
      ? { success: true }
      : { success: false, reason: `页面未出现文本：${value}` };
  }

  if (step.verify?.type === 'element_exists') {
    const selector = step.target?.selector;
    const exists = selector
      ? after.observation.elements.some((element) => element.selector === selector || element.selectors?.includes(selector))
      : Boolean(step.target?.elementId && after.observation.elements.some((element) => element.elementId === step.target?.elementId));
    return exists ? { success: true } : { success: false, reason: '目标元素不存在。' };
  }

  if (step.verify?.type === 'page_changed') {
    const value = step.verify.value || step.target?.text || '';
    const targetAppeared = Boolean(value && !pageText(before).includes(value) && pageText(after).includes(value));
    const active = hasTargetActive(after, value);
    return hasMeaningfulPageChange(before, after) || targetAppeared || active
      ? { success: true }
      : { success: false, reason: `点击后页面没有出现有效变化，目标：${value || step.target?.selector || step.target?.elementId || '未知'}` };
  }

  if (step.verify?.type === 'menu_active') {
    const value = step.verify.value || step.target?.text || '';
    return hasTargetActive(after, value)
      ? { success: true }
      : { success: false, reason: `菜单未变为选中状态：${value}` };
  }

  if (step.verify?.type === 'candidate_count_increased') {
    return countActionableElements(after) > countActionableElements(before)
      ? { success: true }
      : { success: false, reason: '点击后没有出现新的可操作元素。' };
  }

  if (step.verify?.type === 'table_exists') {
    return after.tableCandidates.length > 0
      ? { success: true }
      : { success: false, reason: '页面未发现表格。' };
  }

  if (step.verify?.type === 'value_equals') {
    const value = observedTargetValue(after, step);
    return value === step.verify.value
      ? { success: true }
      : { success: false, reason: `值不匹配：${value || '空'}` };
  }

  if (['click', 'double_click', 'right_click', 'click_by_coordinate'].includes(step.action)) {
    const urlChanged = before.observation.url !== after.observation.url;
    const textAppeared = Boolean(step.target?.text && pageText(after).includes(step.target.text));
    const active = hasTargetActive(after, step.target?.text);
    const changed = hasMeaningfulPageChange(before, after);
    return urlChanged || textAppeared || active || changed
      ? { success: true }
      : { success: false, warning: '点击已执行，但页面变化不明显。', reason: '点击后未检测到 URL、标题、目标文本、active 菜单或候选元素变化。' };
  }

  return { success: true };
}
