import { GLMClient, type GLMSendResult } from '../sidePanel/utils/glm-client';
import {
  getModelProfile,
  validateModelProfile,
  type ModelProfile,
  redactSecrets,
} from '../shared/modelProfiles';

export class ModelGatewayError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ModelGatewayError';
  }
}

type JsonCallInput = {
  system: string;
  user: unknown;
  timeoutMs?: number;
  profileId?: string;
};

type TextCallInput = JsonCallInput & { temperature?: number };

function chatCompletionsUrl(baseUrl: string): string {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
}

async function readModelError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return `HTTP ${response.status}`;
  try {
    const payload = JSON.parse(text);
    return payload?.error?.message || payload?.message || `HTTP ${response.status}`;
  } catch {
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || `HTTP ${response.status}`;
  }
}

export class ModelGateway {
  private client: GLMClient | null = null;
  private profileId = '';
  private profileUpdatedAt = 0;
  private messageHandlers = new Set<Parameters<GLMClient['onMessage']>[0]>();
  private statusHandlers = new Set<Parameters<GLMClient['onStatusChange']>[0]>();

  async getProfile(profileId?: string): Promise<ModelProfile> {
    const profile = await getModelProfile(profileId);
    if (!profile) throw new ModelGatewayError('MODEL_NOT_CONFIGURED', '尚未配置模型，请先在工作台的模型设置中添加 API Key。');
    const error = validateModelProfile(profile);
    if (error) throw new ModelGatewayError('MODEL_NOT_CONFIGURED', error);
    return profile;
  }

  async getClient(profileId?: string): Promise<GLMClient> {
    const profile = await this.getProfile(profileId);
    if (!this.client || this.profileId !== profile.id || this.profileUpdatedAt !== profile.updatedAt) {
      this.client?.cancelCurrentRequest();
      this.client = new GLMClient({ profile });
      this.profileId = profile.id;
      this.profileUpdatedAt = profile.updatedAt;
      this.messageHandlers.forEach((handler) => this.client?.onMessage(handler));
      this.statusHandlers.forEach((handler) => this.client?.onStatusChange(handler));
      this.client.connect();
    }
    return this.client;
  }

  invalidate(): void {
    this.client?.cancelCurrentRequest();
    this.client = null;
    this.profileId = '';
    this.profileUpdatedAt = 0;
  }

  async send(
    messageHistory: any[],
    requestId?: string,
    memoryContext?: string,
    profileId?: string,
    contextTabId?: number,
  ): Promise<GLMSendResult> {
    return (await this.getClient(profileId)).send(messageHistory, undefined, requestId, memoryContext, contextTabId);
  }

  async callJson(input: JsonCallInput): Promise<unknown> {
    const profile = await this.getProfile(input.profileId);
    if (!profile.capabilities.json) throw new ModelGatewayError('MODEL_CAPABILITY_MISSING', '当前模型配置未启用 JSON 能力。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs || 15000);
    try {
      const response = await fetch(chatCompletionsUrl(profile.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
        body: JSON.stringify({
          model: profile.model,
          temperature: 0,
          stream: false,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: typeof input.user === 'string' ? input.user : JSON.stringify(input.user) },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new ModelGatewayError('MODEL_HTTP_ERROR', `模型请求失败：HTTP ${response.status}`);
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new ModelGatewayError('MODEL_INVALID_RESPONSE', '模型未返回可用内容。');
      const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || content;
      return JSON.parse(fenced.trim());
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new ModelGatewayError('NETWORK_ERROR', '模型请求超时。');
      if (error instanceof ModelGatewayError) throw error;
      throw new ModelGatewayError('NETWORK_ERROR', String(redactSecrets(error?.message || error, [profile.apiKey])));
    } finally {
      clearTimeout(timer);
    }
  }

  async completeText(input: TextCallInput): Promise<string> {
    const profile = await this.getProfile(input.profileId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs || 30000);
    try {
      const response = await fetch(chatCompletionsUrl(profile.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
        body: JSON.stringify({
          model: profile.model,
          temperature: input.temperature ?? 0.2,
          stream: false,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: typeof input.user === 'string' ? input.user : JSON.stringify(input.user) },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new ModelGatewayError('MODEL_HTTP_ERROR', `模型请求失败：HTTP ${response.status}`);
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new ModelGatewayError('MODEL_INVALID_RESPONSE', '模型未返回可用内容。');
      return content;
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new ModelGatewayError('NETWORK_ERROR', '模型请求超时。');
      if (error instanceof ModelGatewayError) throw error;
      throw new ModelGatewayError('NETWORK_ERROR', String(redactSecrets(error?.message || error, [profile.apiKey])));
    } finally {
      clearTimeout(timer);
    }
  }

  async uploadFile(input: { name: string; type?: string; bytes: number[] }): Promise<any> {
    const profile = await this.getProfile();
    if (!profile.capabilities.files) throw new ModelGatewayError('MODEL_CAPABILITY_MISSING', '当前模型配置未启用原生文件上传。');
    const errors: string[] = [];
    for (const purpose of ['user_data', 'assistants']) {
      try {
        const formData = new FormData();
        formData.append('file', new Blob([new Uint8Array(input.bytes)], { type: input.type || 'application/octet-stream' }), input.name);
        formData.append('purpose', purpose);
        const response = await fetch(`${profile.baseUrl}/files`, {
          method: 'POST', headers: { Authorization: `Bearer ${profile.apiKey}` }, body: formData,
        });
        const text = await response.text();
        const data = text ? (() => { try { return JSON.parse(text); } catch { return { message: text }; } })() : {};
        if (!response.ok) throw new Error(data?.error?.message || data?.message || `HTTP ${response.status}`);
        const id = data?.id || data?.file_id || data?.data?.id || data?.data?.file_id;
        if (!id) throw new Error('文件上传成功但未返回 file_id');
        return { id, name: data?.filename || data?.name || input.name, type: input.type, size: data?.bytes || data?.size || input.bytes.length, purpose, status: data?.status, createdAt: data?.created_at, raw: data };
      } catch (error: any) {
        errors.push(String(redactSecrets(error?.message || error, [profile.apiKey])));
      }
    }
    throw new ModelGatewayError('MODEL_FILE_UPLOAD_ERROR', errors.join('；') || '模型文件上传失败');
  }

  cancel(): GLMSendResult {
    return this.client?.cancelCurrentRequest() || { success: false, cancelled: true, error: '当前没有正在生成的请求' };
  }

  getStatus(): string {
    return this.client?.getStatus() || 'disconnected';
  }

  onMessage(handler: Parameters<GLMClient['onMessage']>[0]): () => void {
    this.messageHandlers.add(handler);
    this.client?.onMessage(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: Parameters<GLMClient['onStatusChange']>[0]): () => void {
    this.statusHandlers.add(handler);
    this.client?.onStatusChange(handler);
    return () => this.statusHandlers.delete(handler);
  }

  async test(profile: ModelProfile): Promise<void> {
    const error = validateModelProfile(profile);
    if (error) throw new ModelGatewayError('MODEL_NOT_CONFIGURED', error);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(chatCompletionsUrl(profile.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
        body: JSON.stringify({ model: profile.model, stream: false, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await readModelError(response);
        throw new ModelGatewayError(
          'MODEL_HTTP_ERROR',
          `连接测试失败：HTTP ${response.status}，${String(redactSecrets(detail, [profile.apiKey]))}`,
        );
      }
    } catch (testError: any) {
      if (testError?.name === 'AbortError') throw new ModelGatewayError('NETWORK_ERROR', '连接测试超时，请检查 Base URL 或网络。');
      if (testError instanceof ModelGatewayError) throw testError;
      throw new ModelGatewayError(
        'NETWORK_ERROR',
        `无法连接模型服务：${String(redactSecrets(testError?.message || testError, [profile.apiKey]))}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
