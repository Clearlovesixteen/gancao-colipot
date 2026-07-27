export function shouldRouteToDocumentQa(message: string, hasAttachedFiles = false): boolean {
  const text = message.trim();
  if (!text || hasAttachedFiles) return false;
  return /(资料|文件|文档|附件|PDF|Word|Excel|OCR|总结|对比|差异|风险|字段|任务|需求|清单)/i.test(text);
}
