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

export class SSEClient {
  private sendUrl: string;
  private messageHandlers: Set<(message: Message) => void> = new Set();
  private statusHandlers: Set<(status: 'connected' | 'disconnected' | 'connecting' | 'error') => void> = new Set();
  private currentStatus: 'connected' | 'disconnected' | 'connecting' | 'error' = 'disconnected';
  private abortController: AbortController | null = null;
  private messageHistory: Array<{ role: string; content: string; tool_call_id?: string }> = [];

  constructor(sendUrl: string) {
    this.sendUrl = sendUrl;
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

  async send(messageHistory: Array<{ role: string; content: string; tool_call_id?: string }>): Promise<boolean> {
    if (!messageHistory || messageHistory.length === 0) {
      return false;
    }

    // 保存消息历史
    this.messageHistory = [...messageHistory];

    // 取消之前的请求（如果有）
    if (this.abortController) {
      this.abortController.abort();
    }

    this.abortController = new AbortController();
    this.setStatus('connecting');

    // 为这次请求生成唯一的消息 ID
    const requestMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const response = await fetch(this.sendUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          books: [],
          message: messageHistory,
          type: 1
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // 检查响应类型
      const contentType = response.headers.get('content-type') || '';
      
      if (contentType.includes('text/event-stream') || contentType.includes('text/plain') || contentType.includes('application/x-ndjson')) {
        // SSE 格式或流式响应
        await this.handleStreamResponse(response, requestMessageId);
      } else {
        // 普通 JSON 响应
        const data = await response.json();
        await this.handleMessage(data, requestMessageId);
      }

      this.setStatus('connected');
      return true;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return false;
      }
      this.setStatus('error');
      return false;
    }
  }

  private async handleStreamResponse(response: Response, defaultMessageId: string): Promise<void> {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    
    if (!reader) {
      throw new Error('No response body reader available');
    }

    let buffer = '';
    let messageId = defaultMessageId;
    let accumulatedContent = ''; 

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; 

        for (const line of lines) {
          const trimmedLine = line.trim();
          
          if (!trimmedLine) {
            continue;
          }

          // 处理 SSE 格式
          if (trimmedLine.startsWith('data: ')) {
            const data = trimmedLine.slice(6).trim();
            
            if (data === '[DONE]' || data === 'done') {
              // 流结束，发送最终累积的内容
              if (accumulatedContent) {
                await this.handleFinalMessage(accumulatedContent, messageId);
                accumulatedContent = '';
              }
              continue;
            }

            this.processMessageData(data, messageId, accumulatedContent, (newContent) => {
              accumulatedContent = newContent;
            });
            continue;
          }

          if (trimmedLine.startsWith('event: ')) {
            continue;
          }

          if (trimmedLine.startsWith('id: ')) {
            messageId = trimmedLine.slice(4).trim();
            continue;
          }

          
          if (trimmedLine.startsWith('message ')) {
            const jsonStr = trimmedLine.slice(8).trim();
            this.processMessageData(jsonStr, messageId, accumulatedContent, (newContent) => {
              accumulatedContent = newContent;
            });
            continue;
          }

          
          this.processMessageData(trimmedLine, messageId, accumulatedContent, (newContent) => {
            accumulatedContent = newContent;
          });
        }
      }

     
      if (buffer.trim()) {
        const finalContent = accumulatedContent + buffer.trim();
        await this.handleFinalMessage(finalContent, messageId);
      } else if (accumulatedContent) {
        await this.handleFinalMessage(accumulatedContent, messageId);
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 处理最终消息
   */
  private async handleFinalMessage(content: string, messageId: string): Promise<void> {
    // 发送最终消息
    this.notifyMessage({
      id: messageId,
      content: content,
      type: 'assistant',
      timestamp: Date.now(),
    });

    // 将消息添加到历史记录
    this.messageHistory.push({
      role: 'assistant',
      content: content,
    });
  }

  
  private processMessageData(
    dataStr: string,
    messageId: string,
    currentAccumulatedContent: string,
    updateAccumulatedContent: (newContent: string) => void
  ): void {
    try {
      const jsonData = JSON.parse(dataStr);
      
      // 根据消息类型处理
      const msgType = jsonData.type;
      
      if (msgType === 'text') {
        // text 类型：累积内容并实时更新显示
        const content = jsonData.content || '';
        if (content) {
          const newAccumulatedContent = currentAccumulatedContent + content;
          updateAccumulatedContent(newAccumulatedContent);
          // 实时发送增量更新
          this.notifyMessage({
            id: messageId,
            content: newAccumulatedContent,
            type: 'assistant',
            timestamp: Date.now(),
          });
        }
      } else if (msgType === 'think') {
       //排除think类型
      } else if (msgType === 'recall_list') {
        // 排除 recall_list
      } else if (jsonData.content || jsonData.message || jsonData.text) {
        // 兼容其他格式
        const content = jsonData.content || jsonData.message || jsonData.text;
      
        // 如果是增量更新，累加内容
        if (jsonData.delta || jsonData.incremental) {
          const newAccumulatedContent = currentAccumulatedContent + content;
          updateAccumulatedContent(newAccumulatedContent);
          this.notifyMessage({
            id: messageId,
            content: newAccumulatedContent,
            type: 'assistant',
            timestamp: Date.now(),
          });
        } else {
          updateAccumulatedContent(content);
          this.notifyMessage({
            id: jsonData.id || messageId,
            content: content,
            type: jsonData.type || 'assistant',
            timestamp: jsonData.timestamp || Date.now(),
          });
        }
      }
    } catch (parseError) {
      // 如果不是 JSON，作为纯文本处理
      const newAccumulatedContent = currentAccumulatedContent + dataStr;
      updateAccumulatedContent(newAccumulatedContent);
      this.notifyMessage({
        id: messageId,
        content: newAccumulatedContent,
        type: 'assistant',
        timestamp: Date.now(),
      });
    }
  }

  private async handleMessage(data: any, defaultMessageId?: string): Promise<void> {
    const content = data.content || data.message || data.text || JSON.stringify(data);
    const messageId = data.id || defaultMessageId || Date.now().toString();
    
    await this.handleFinalMessage(content, messageId);
  }

  disconnect(): void {
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
}
