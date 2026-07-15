import { afterEach, describe, expect, it, vi } from 'vitest';
import { GLMClient, type Message } from './glm-client';
import type { ModelProfile } from '../../shared/modelProfiles';

const profile: ModelProfile = {
  id: 'test-model',
  name: 'Test Model',
  provider: 'openai_compatible',
  baseUrl: 'https://model.example/v1',
  model: 'test-model',
  apiKey: 'test-key',
  capabilities: { streaming: true, tools: false, json: true, files: false },
  active: true,
  createdAt: 1,
  updatedAt: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete (chrome.runtime as any).sendMessage;
});

describe('GLMClient streaming', () => {
  it('兼容没有空格的 data: SSE 行并逐段通知 UI', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data:{"choices":[{"delta":{"content":"你"}}]}\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"好"}}]}\n'));
        controller.enqueue(encoder.encode('data:[DONE]\n'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    const client = new GLMClient({ profile });
    const messages: Message[] = [];
    client.onMessage((message) => messages.push(message));

    await expect(client.send([{ role: 'user', content: '你好' }], undefined, 'request-1')).resolves.toEqual({ success: true });
    expect(messages.map((message) => message.content)).toContain('你');
    expect(messages.map((message) => message.content)).toContain('你好');
  });

  it('递归工具调用始终携带发起请求时绑定的业务标签页', async () => {
    const encoder = new TextEncoder();
    const stream = (payload: string) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }), { status: 200 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(stream([
        'data:{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool-1","function":{"name":"get_current_page_info","arguments":"{}"}}]}}]}',
        'data:{"choices":[{"finish_reason":"tool_calls","delta":{}}]}',
        'data:[DONE]',
        '',
      ].join('\n')))
      .mockResolvedValueOnce(stream([
        'data:{"choices":[{"delta":{"content":"当前是业务页面"}}]}',
        'data:[DONE]',
        '',
      ].join('\n')));
    vi.stubGlobal('fetch', fetchMock);
    const sendMessage = vi.fn(async () => ({ success: true, result: { url: 'https://business.example/' } }));
    (chrome.runtime as any).sendMessage = sendMessage;

    const client = new GLMClient({
      profile: { ...profile, capabilities: { ...profile.capabilities, tools: true } },
    });
    await expect(client.send(
      [{ role: 'user', content: '提取当前页面数据' }],
      undefined,
      'request-2',
      undefined,
      42,
    )).resolves.toEqual({ success: true });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'EXECUTE_TOOL',
      toolName: 'get_current_page_info',
      tabId: 42,
    }));
  });
});
