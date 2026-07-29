import { describe, expect, it } from 'vitest';
import {
  hasRenderableChatMessage,
  mergeIncomingChatMessage,
  shouldPersistIncomingChatMessage,
} from './chatMessageState';

describe('chatMessageState', () => {
  it('不渲染只有时间戳语义的空消息', () => {
    expect(hasRenderableChatMessage({ id: 'empty', content: '   ' })).toBe(false);
    expect(hasRenderableChatMessage({ id: 'file', content: '', attachments: [{ name: 'a.pdf' }] })).toBe(true);
  });

  it('流式消息按 id 原位更新，不要求它是列表最后一条', () => {
    const messages = [
      { id: 'assistant-1', content: '你', delivery: 'streaming' as const },
      { id: 'tool-1', content: '正在读取页面', delivery: 'tool' as const },
    ];
    const next = mergeIncomingChatMessage(messages, {
      id: 'assistant-1',
      content: '你好',
      delivery: 'final' as const,
    });

    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ id: 'assistant-1', content: '你好', delivery: 'final' });
    expect(next[1]).toEqual(messages[1]);
  });

  it('增量内容不反复落库，最终内容才持久化', () => {
    expect(shouldPersistIncomingChatMessage({ id: 'a', content: '你', delivery: 'streaming' })).toBe(false);
    expect(shouldPersistIncomingChatMessage({ id: 'a', content: '你好', delivery: 'final' })).toBe(true);
  });
});
