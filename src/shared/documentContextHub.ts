import {
  getDocumentAsset,
  getDocumentContent,
  listDocumentAssets,
  searchDocuments,
} from './documentRepository';

export interface DocumentContextSource {
  documentId: string;
  documentTitle: string;
  chunkId?: string;
  pageNumber?: number;
  sectionTitle?: string;
  text: string;
  warnings?: string[];
}

export interface DocumentContextHubResult {
  question: string;
  sources: DocumentContextSource[];
  matchedBySearch: boolean;
  warnings: string[];
}

export async function collectDocumentContextHub(input: {
  question: string;
  documentIds?: string[];
  limit?: number;
  fallbackDocumentLimit?: number;
}): Promise<DocumentContextHubResult> {
  const question = String(input.question || '').trim();
  const matches = await searchDocuments(question, input.documentIds, input.limit || 8);
  const warnings: string[] = [];
  if (matches.length) {
    const sources = matches.map((match) => {
      const sourceWarnings = [
        match.asset.ocrStatus === 'partial' ? 'OCR 结果置信度较低，需要人工核对。' : '',
        match.asset.localParseStatus === 'partial' ? '文件本地解析不完整。' : '',
      ].filter(Boolean);
      warnings.push(...sourceWarnings.map((warning) => `${match.asset.title}：${warning}`));
      return {
        documentId: match.asset.id,
        documentTitle: match.asset.title,
        chunkId: match.chunk.id,
        pageNumber: match.chunk.pageNumber,
        sectionTitle: match.chunk.sectionTitle,
        text: match.chunk.text.slice(0, 2400),
        warnings: sourceWarnings,
      };
    });
    return { question, sources, matchedBySearch: true, warnings: [...new Set(warnings)] };
  }

  const fallbackIds = input.documentIds?.length
    ? input.documentIds
    : (await listDocumentAssets()).slice(0, input.fallbackDocumentLimit || 3).map((asset) => asset.id);
  const fallbackSources = await Promise.all(fallbackIds.map(async (id): Promise<DocumentContextSource | null> => {
    const [asset, content] = await Promise.all([getDocumentAsset(id), getDocumentContent(id)]);
    if (!asset || !content?.text?.trim()) return null;
    const sourceWarnings = [
      '未检索到精确 chunk，当前使用资料全文摘要作为兜底。',
      asset.ocrStatus === 'partial' ? 'OCR 结果置信度较低，需要人工核对。' : '',
    ].filter(Boolean);
    warnings.push(...sourceWarnings.map((warning) => `${asset.title}：${warning}`));
    return {
      documentId: id,
      documentTitle: asset.title,
      text: content.text.slice(0, 6000),
      warnings: sourceWarnings,
    };
  }));
  const sources = fallbackSources.filter((source): source is DocumentContextSource => source !== null);
  return { question, sources, matchedBySearch: false, warnings: [...new Set(warnings)] };
}
