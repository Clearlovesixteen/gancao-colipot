import { describe, expect, it, vi } from 'vitest';
import { runDocumentQaAgent, runPageDiagnosisAgent, shouldRouteToDocumentQa } from './agentOrchestrator';

describe('agentOrchestrator', () => {
  it('builds a page diagnosis prompt even when no console errors are captured', async () => {
    const executeTool = vi.fn(async (toolName: string) => {
      if (toolName === 'get_current_page_info') {
        return { success: true, title: '测试页面', url: 'https://example.com/a', text: '页面正文 无权限 验证码' };
      }
      if (toolName === 'extract_page_structured_data') {
        return {
          success: true,
          asset: { id: 'page_1', title: '测试页面' },
          data: { title: '测试页面', url: 'https://example.com/a', fields: [], tables: [], lists: [] },
        };
      }
      if (toolName === 'observe_page') {
        return {
          success: true,
          pageState: { kind: 'login_page', hasLoginSignal: true, hasCaptcha: true },
          elements: [{ role: 'button', tag: 'button', text: '登录', visible: true, enabled: true }],
        };
      }
      throw new Error(`unexpected tool: ${toolName}`);
    });
    const collectConsoleErrors = vi.fn(async () => ({ success: true, errors: [] }));

    const result = await runPageDiagnosisAgent({ executeTool, collectConsoleErrors });

    expect(result.success).toBe(true);
    expect(result.agentType).toBe('page_diagnosis');
    expect(result.prompt).toContain('未捕获到控制台错误');
    expect(result.prompt).toContain('风险等级');
    expect(result.prompt).toContain('hasLoginSignal');
    expect(result.prompt).toContain('hasCaptchaSignal');
    expect(result.prompt).toContain('hasPermissionSignal');
    expect(result.sources.some((source) => source.type === 'structured_data')).toBe(true);
  });

  it('falls back to reading documents when document search has weak matches', async () => {
    const executeTool = vi.fn(async (toolName: string) => {
      if (toolName === 'list_documents') {
        return {
          success: true,
          documents: [
            {
              id: 'doc_1',
              title: '需求文档',
              localParseStatus: 'parsed',
              nativeUploadStatus: 'uploaded',
              ocrStatus: 'not_needed',
            },
          ],
        };
      }
      if (toolName === 'search_documents') {
        return {
          success: true,
          matches: [{
            asset: { id: 'doc_1', title: '需求文档' },
            chunk: {
              id: 'chunk_1',
              assetId: 'doc_1',
              title: '需求文档',
              text: '风险：缺少验收标准。',
              pageNumber: 2,
              sectionTitle: '风险分析',
              index: 0,
            },
          }],
        };
      }
      if (toolName === 'read_document') {
        return {
          success: true,
          asset: { id: 'doc_1', title: '需求文档' },
          content: {
            text: '完整资料正文',
            tables: [],
            metadata: {},
            structuredOcr: {
              summary: 'OCR 摘要',
              documentType: 'report',
              pageCount: 2,
              warnings: ['疑似低置信度文本'],
              fields: [],
              tables: [],
              sections: [],
            },
          },
          chunks: [],
        };
      }
      throw new Error(`unexpected tool: ${toolName}`);
    });

    const result = await runDocumentQaAgent({ query: '总结风险', executeTool });

    expect(result.success).toBe(true);
    expect(result.agentType).toBe('document_qa');
    expect(result.prompt).toContain('完整资料正文');
    expect(result.prompt).toContain('S1｜需求文档｜第 2 页｜章节：风险分析｜chunk：chunk_1');
    expect(result.prompt).toContain('OCR 提示');
    expect(result.prompt).toContain('每个关键结论都要标注引用来源');
    expect(executeTool).toHaveBeenCalledWith('read_document', { id: 'doc_1', maxLength: 20000 });
  });

  it('routes document-like messages to document qa', () => {
    expect(shouldRouteToDocumentQa('帮我总结这些资料里的风险')).toBe(true);
    expect(shouldRouteToDocumentQa('你好')).toBe(false);
    expect(shouldRouteToDocumentQa('总结这个附件', true)).toBe(false);
  });
});
