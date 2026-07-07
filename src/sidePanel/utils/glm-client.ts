
import { BUSINESS_TOOLS } from '../../shared/businessTools';

const LLM_API_KEY = 'sk-999a697580b446de8d741682508523bb';
const LLM_BASE_URL = 'https://api.deepseek.com';
const LLM_MODEL_NAME = 'deepseek-v4-pro';

// 导出 Message 接口，与 SSE 客户端保持一致
export interface Message {
  id: string;
  content: string;
  type: 'user' | 'system' | 'assistant';
  timestamp: number;
  requestId?: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, any>;
  }>;
}

export interface NativeFileReference {
  id: string;
  name?: string;
  type?: string;
  size?: number;
}

type GLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'file'; file: { file_id: string } };

export interface GLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | GLMContentPart[];
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface GLMClientOptions {
  tabId?: number;
}

export interface GLMSendResult {
  success: boolean;
  cancelled?: boolean;
  error?: string;
}

type GLMHistoryMessage = {
  role: string;
  content: string;
  nativeFiles?: NativeFileReference[];
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

const MODEL_SUPPORTS_NATIVE_FILES = false;
const MAX_TOOL_RESULT_CONTENT_LENGTH = 60000;

function stringifyToolResult(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  if (!text) return '{}';
  if (text.length <= MAX_TOOL_RESULT_CONTENT_LENGTH) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CONTENT_LENGTH)}\n\n[工具结果过长，已截断 ${text.length - MAX_TOOL_RESULT_CONTENT_LENGTH} 字符]`;
}

function normalizeRequestError(error: any): string {
  const message = String(error?.message || error || 'AI 请求失败');
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return '无法连接模型服务，请检查网络、模型接口地址或浏览器扩展是否允许访问模型 API。';
  }
  if (/HTTP error!\s*status:\s*400/i.test(message) && /missing field [`']?content[`']?|deserialize/i.test(message)) {
    return '模型请求格式不完整：有一条历史消息缺少 content。请重新发送本轮消息；如果反复出现，需要检查工具调用消息的组装逻辑。';
  }
  if (/HTTP error!\s*status:\s*400/i.test(message)) {
    return '模型拒绝了本次请求：请求内容格式或上下文过长可能不符合接口要求。请缩短上下文后重试。';
  }
  if (/HTTP error!\s*status:\s*5\d\d/i.test(message)) {
    return '模型服务暂时不可用，请稍后重试。';
  }
  return message;
}

export class GLMClient {
  private messageHandlers: Set<(message: Message) => void> = new Set();
  private statusHandlers: Set<(status: 'connected' | 'disconnected' | 'connecting' | 'error') => void> = new Set();
  private currentStatus: 'connected' | 'disconnected' | 'connecting' | 'error' = 'disconnected';
  private abortController: AbortController | null = null;
  private activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private cancelRequested = false;
  private lastError: string | null = null;
  private messageHistory: GLMHistoryMessage[] = [];
  private activeRunId = 0;
  private activeMemoryContext = '';

  constructor(options?: GLMClientOptions) {
    // 初始化时设置状态
    this.setStatus('disconnected');
  }

  connect(): void {
    this.setStatus('connected');
  }

  private setStatus(status: 'connected' | 'disconnected' | 'connecting' | 'error'): void {
    if (this.currentStatus !== status) {
      this.currentStatus = status;
      this.notifyStatus(status);
    }
  }


  /**
   * 发送消息并处理响应
   */
  async send(
    messageHistory: GLMHistoryMessage[],
    continuedRunId?: number,
    requestId?: string,
    memoryContext?: string
  ): Promise<GLMSendResult> {
    if (!messageHistory || messageHistory.length === 0) {
      return { success: false, error: '消息为空' };
    }

    const isContinuation = typeof continuedRunId === 'number';
    if (!isContinuation) {
      this.activeRunId += 1;
      this.cancelRequested = false;
      this.lastError = null;
      this.activeMemoryContext = memoryContext?.trim() || '';
    }
    const runId = isContinuation ? continuedRunId : this.activeRunId;

    if (this.cancelRequested || runId !== this.activeRunId) {
      this.setStatus('connected');
      return { success: false, cancelled: true, error: '已停止生成' };
    }

    // 保存消息历史
    this.messageHistory = [...messageHistory];

    // 取消之前的请求（如果有）
    if (this.abortController) {
      this.abortController.abort();
    }

    const controller = new AbortController();
    this.abortController = controller;
    this.setStatus('connecting');

    // 为这次请求生成唯一的消息 ID
    const requestMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const buildMessageContent = (msg: GLMHistoryMessage): GLMMessage['content'] => {
        const nativeFiles = Array.isArray(msg.nativeFiles)
          ? msg.nativeFiles.filter(file => file?.id)
          : [];

        if (!MODEL_SUPPORTS_NATIVE_FILES || msg.role !== 'user' || nativeFiles.length === 0) {
          return msg.content;
        }

        return [
          { type: 'text', text: msg.content || '请分析我上传的文件。' },
          ...nativeFiles.map(file => ({
            type: 'file' as const,
            file: { file_id: file.id },
          })),
        ];
      };

      // 构建消息列表
      const messages: GLMMessage[] = messageHistory.map(msg => ({
        role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
        content: buildMessageContent(msg),
        tool_call_id: msg.tool_call_id,
        tool_calls: msg.tool_calls,
      }));

      // 添加系统消息
      const systemMessage: GLMMessage = {
        role: 'system',
        content: `你是甘草 Copliot 的业务助手，不只是浏览器自动化工具。

你的目标：
- 理解用户的业务需求，先判断用户是在咨询、分析文件、整理网页信息、处理表格，还是要执行流程。
- 能直接回答时直接回答；需要上下文时先调用工具读取当前网页、上传文件或历史材料。
- 能用工具完成的低风险动作可以调用工具；涉及提交、删除、购买、付款、发送消息、修改线上数据等高风险动作前，必须先向用户确认。
- 对需求文档、表格、网页内容要输出结构化结果，例如摘要、待办、风险点、字段清单、流程建议。
- 当用户想沉淀重复工作时，生成业务流程草稿，而不是只给浏览器点击步骤。
- 当用户提到已上传的文件、PDF、Word、PPT、Excel、需求文档或“这个文件”时，优先调用 list_documents / search_documents / read_document 获取资料中心内容；旧工具 list_uploaded_files/read_uploaded_file 只作为兼容兜底。
- 用户问具体问题时先用 search_documents 检索相关片段，并在回答中说明引用来源（文件名、页码/章节、片段摘要）。
- 用户要求需求文档拆任务时调用 generate_requirement_tasks，并基于返回的任务清单总结，不要只泛泛建议。
- 用户要求提取当前网页数据、表格或字段时调用 extract_page_structured_data。
- 用户要求诊断当前页面报错、控制台错误或页面异常时调用 get_console_errors，并基于错误 message/stack/source 给出定位和修复建议。
- 用户要求操作当前页面、点击、输入、填表、选择、导出或跑一次性流程时，先调用 observe_page 观察页面元素，再用 browser_action 执行动作；明确要求导出/下载时使用 download_file，涉及提交、删除、购买、支付、发送、保存、修改等高风险动作前必须向用户确认。
- 当前接入的是纯文本模型，不支持直接读取图片/PDF 原生附件；所有文件能力必须通过资料中心、本地解析、OCR 结构化结果和工具返回的文本完成。
- 如果用户消息中已经包含“附件解析结果/解析正文/OCR 结构化结果”，必须直接基于该内容分析，不要重复声称无法读取附件。

可用能力：
- 获取当前网页信息和查询页面元素。
- 观察当前页面可交互元素，并执行有限的浏览器动作。
- 列出和读取用户上传/粘贴的文件。
- 检索资料中心、读取资料分块、生成需求任务清单。
- 提取当前网页字段、表格和列表并生成结构化数据。
- 读取当前页面控制台报错并辅助诊断。
- 生成业务流程草稿。${this.activeMemoryContext ? `\n\n长期记忆参考：\n${this.activeMemoryContext}` : ''}`,
      };
      
      // 检查是否已有系统消息，如果没有则添加
      const hasSystemMessage = messages.some(msg => msg.role === 'system');
      if (!hasSystemMessage) {
        messages.unshift(systemMessage);
      }
      
      // 构建消息列表，处理 tool_calls
      const formattedMessages: GLMMessage[] = messages.map(msg => {
        const formatted: GLMMessage = {
          role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
          content: msg.content,
          tool_call_id: msg.tool_call_id,
        };
        
        // 如果有 tool_calls，添加到消息中
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          formatted.tool_calls = msg.tool_calls;
        }
        
        return formatted;
      });
      
      // 调用 API
      const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: LLM_MODEL_NAME,
          messages: formattedMessages,
          tools: BUSINESS_TOOLS,
          tool_choice: 'auto',
          stream: true,
          temperature: 0,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
      }

      // 处理流式响应
      await this.handleStreamResponse(response, requestMessageId, runId, requestId);

      if (this.cancelRequested || runId !== this.activeRunId) {
        this.setStatus('connected');
        return { success: false, cancelled: true, error: '已停止生成' };
      }

      this.setStatus('connected');
      if (this.abortController === controller) {
        this.abortController = null;
      }
      return { success: true };
    } catch (error: any) {
      if (this.abortController === controller) {
        this.abortController = null;
      }
      if (this.cancelRequested || runId !== this.activeRunId) {
        this.setStatus('connected');
        return { success: false, cancelled: true, error: '已停止生成' };
      }
      if (error.name === 'AbortError') {
        const cancelled = this.cancelRequested || runId !== this.activeRunId;
        this.setStatus('connected');
        return { success: false, cancelled, error: cancelled ? '已停止生成' : '请求已取消' };
      }
      console.error('[GLMClient] 发送消息失败:', error);
      this.lastError = normalizeRequestError(error);
      this.setStatus('error');
      return { success: false, error: this.lastError || 'AI 请求失败' };
    }
  }

  /**
   * 处理流式响应
   */
  private async handleStreamResponse(
    response: Response,
    defaultMessageId: string,
    runId: number,
    requestId?: string
  ): Promise<void> {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    
    if (!reader) {
      throw new Error('No response body reader available');
    }

    let buffer = '';
    let messageId = defaultMessageId;
    let accumulatedContent = '';
    let accumulatedToolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, any>;
    }> = [];
    let finishReason: string | null = null;

    this.activeReader = reader;

    const ensureRunActive = () => {
      if (this.cancelRequested || runId !== this.activeRunId) {
        throw new DOMException('已停止生成', 'AbortError');
      }
    };

    try {
      while (true) {
        ensureRunActive();

        const { done, value } = await reader.read();
        ensureRunActive();
        
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();
          
          if (!trimmedLine || !trimmedLine.startsWith('data: ')) {
            continue;
          }

          const dataStr = trimmedLine.slice(6).trim();
          
            if (dataStr === '[DONE]') {
              ensureRunActive();
              // 流结束，处理工具调用或最终消息
              if (accumulatedToolCalls.length > 0) {
                await this.handleToolCalls(accumulatedToolCalls, messageId, runId, requestId);
                return; // 工具调用后需要等待执行结果
              } else if (accumulatedContent) {
                await this.handleFinalMessage(accumulatedContent, messageId, runId, requestId);
              }
              continue;
          }

          try {
            const data = JSON.parse(dataStr);
            const choice = data.choices?.[0];
            
            if (!choice) {
              continue;
            }

            // 记录 finish_reason
            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            const delta = choice.delta;

            // 处理内容增量
            if (delta?.content) {
              ensureRunActive();
              accumulatedContent += delta.content;
              // 实时发送增量更新
              this.notifyMessage({
                id: messageId,
                content: accumulatedContent,
                type: 'assistant',
                timestamp: Date.now(),
                requestId,
              });
            }

            // 处理工具调用增量
            if (delta?.tool_calls) {
              for (const toolCallDelta of delta.tool_calls) {
                const index = toolCallDelta.index ?? 0;
                if (!accumulatedToolCalls[index]) {
                  accumulatedToolCalls[index] = {
                    id: toolCallDelta.id || `tool_${Date.now()}_${index}`,
                    name: '',
                    arguments: {},
                  };
                }
                if (toolCallDelta.function?.name) {
                  accumulatedToolCalls[index].name = toolCallDelta.function.name;
                }
                if (toolCallDelta.function?.arguments) {
                  const currentArgs =
                    typeof accumulatedToolCalls[index].arguments._raw === 'string'
                      ? accumulatedToolCalls[index].arguments._raw
                      : '';
                  const nextArgs = currentArgs + toolCallDelta.function.arguments;

                  try {
                    const parsedArgs = JSON.parse(nextArgs);
                    accumulatedToolCalls[index].arguments = parsedArgs;
                    accumulatedToolCalls[index].arguments._raw = nextArgs;
                  } catch {
                    // 如果解析失败，累积原始字符串
                    accumulatedToolCalls[index].arguments._raw = nextArgs;
                  }
                }
              }
            }

            // 如果 finish_reason 是 tool_calls，立即处理
            if (finishReason === 'tool_calls' && accumulatedToolCalls.length > 0) {
              ensureRunActive();
              await this.handleToolCalls(accumulatedToolCalls, messageId, runId, requestId);
              return; // 工具调用后需要等待执行结果，停止流处理
            }

          } catch (parseError) {
            if ((parseError as any)?.name === 'AbortError') {
              throw parseError;
            }
            // 忽略解析错误，继续处理下一行
            console.warn('[GLMClient] 解析响应数据失败:', parseError, dataStr);
          }
        }
      }

      // 流结束后处理工具调用或最终消息
      ensureRunActive();
      if (accumulatedToolCalls.length > 0) {
        await this.handleToolCalls(accumulatedToolCalls, messageId, runId, requestId);
      } else if (accumulatedContent) {
        await this.handleFinalMessage(accumulatedContent, messageId, runId, requestId);
      }
    } finally {
      if (this.activeReader === reader) {
        this.activeReader = null;
      }
      try {
        reader.releaseLock();
      } catch {
        // Reader may already be cancelled/released after an abort.
      }
    }
  }

  /**
   * 处理最终消息
   */
  private async handleFinalMessage(
    content: string,
    messageId: string,
    runId: number,
    requestId?: string
  ): Promise<void> {
    if (this.cancelRequested || runId !== this.activeRunId) {
      return;
    }

    // 发送最终消息
    this.notifyMessage({
      id: messageId,
      content: content,
      type: 'assistant',
      timestamp: Date.now(),
      requestId,
    });

    // 将消息添加到历史记录
    this.messageHistory.push({
      role: 'assistant',
      content: content,
    });
  }

  /**
   * 处理工具调用
   */
  private async handleToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, any> }>,
    messageId: string,
    runId: number,
    requestId?: string
  ): Promise<void> {
    if (this.cancelRequested || runId !== this.activeRunId) {
      return;
    }

    // 清理参数中的 _raw 字段
    const cleanedToolCalls = toolCalls.map(tc => {
      const cleanedArgs = { ...tc.arguments };
      delete (cleanedArgs as any)._raw;
      return {
        ...tc,
        arguments: cleanedArgs,
      };
    });

    // 发送工具调用消息到 UI
    if (this.cancelRequested || runId !== this.activeRunId) {
      return;
    }
    this.notifyMessage({
      id: messageId,
      content: `正在执行工具调用: ${cleanedToolCalls.map(tc => tc.name).join(', ')}`,
      type: 'assistant',
      timestamp: Date.now(),
      requestId,
      tool_calls: cleanedToolCalls,
    });

    // 将 assistant 消息（包含 tool_calls）添加到历史记录
      const toolCallSummary = `正在执行工具调用: ${cleanedToolCalls.map(tc => tc.name).join(', ')}`;
      const assistantMessage = {
        role: 'assistant',
        content: toolCallSummary,
        tool_calls: cleanedToolCalls.map(tc => ({
          id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    };
    this.messageHistory.push(assistantMessage);

    // 通过 background script 执行工具调用
    const toolResults = await Promise.all(
      cleanedToolCalls.map(async (toolCall) => {
        try {
          const result = await chrome.runtime.sendMessage({
            type: 'EXECUTE_TOOL',
            toolName: toolCall.name,
            arguments: toolCall.arguments,
          });
          return {
            tool_call_id: toolCall.id,
            role: 'tool' as const,
            content: stringifyToolResult(result),
          };
        } catch (error: any) {
          console.error(`[GLMClient] 工具执行失败 ${toolCall.name}:`, error);
          return {
            tool_call_id: toolCall.id,
            role: 'tool' as const,
            content: JSON.stringify({ 
              error: error.message || '工具执行失败',
              toolName: toolCall.name,
            }),
          };
        }
      })
    );

    if (this.cancelRequested || runId !== this.activeRunId) {
      return;
    }

    // 将工具执行结果添加到消息历史
    toolResults.forEach(result => {
      this.messageHistory.push({
        role: result.role,
        content: result.content,
        tool_call_id: result.tool_call_id,
      });
    });

    // 递归调用 send，继续对话
    const continued = await this.send(this.messageHistory, runId, requestId);
    if (!continued.success) {
      if (continued.cancelled) {
        return;
      }
      const errorMessage = continued.error || this.lastError || '工具执行后继续请求 AI 失败';
      throw new Error(errorMessage);
    }
  }

  cancelCurrentRequest(): GLMSendResult {
    this.cancelRequested = true;
    this.activeRunId += 1;

    if (this.activeReader) {
      try {
        this.activeReader.cancel('已停止生成').catch(() => {});
      } catch {
        // Ignore cancellation races.
      }
      this.activeReader = null;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    this.setStatus('connected');
    return { success: true, cancelled: true };
  }

  disconnect(): void {
    this.cancelRequested = true;
    this.activeRunId += 1;

    if (this.activeReader) {
      try {
        this.activeReader.cancel('已断开连接').catch(() => {});
      } catch {
        // Ignore cancellation races.
      }
      this.activeReader = null;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.setStatus('disconnected');
  }

  onMessage(handler: (message: Message) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onStatusChange(handler: (status: 'connected' | 'disconnected' | 'connecting' | 'error') => void): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  private notifyMessage(message: Message): void {
    this.messageHandlers.forEach(handler => handler(message));
  }

  private notifyStatus(status: 'connected' | 'disconnected' | 'connecting' | 'error'): void {
    this.statusHandlers.forEach(handler => handler(status));
  }

  getStatus(): 'connected' | 'disconnected' | 'connecting' | 'error' {
    return this.currentStatus;
  }

  getLastError(): string | null {
    return this.lastError;
  }
}
