import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildMemoryContext,
  clearChatHistory,
  clearUserMemories,
  createChatSession,
  deleteChatSession,
  getChatSessionMessages,
  isMemoryEnabled,
  recallMemories,
  saveChatMessage,
  setMemoryEnabled,
  upsertUserMemory,
} from './userMemoryStore';

describe('userMemoryStore', () => {
  beforeEach(async () => {
    await clearChatHistory();
    await clearUserMemories();
    await setMemoryEnabled(true);
  });

  it('creates sessions and stores ordered chat messages', async () => {
    const session = await createChatSession();
    await saveChatMessage({
      id: 'msg_2',
      sessionId: session.id,
      role: 'assistant',
      content: '好的',
      timestamp: 2,
    });
    await saveChatMessage({
      id: 'msg_1',
      sessionId: session.id,
      role: 'user',
      content: '帮我记住 WMS 导出流程',
      timestamp: 1,
    });

    const messages = await getChatSessionMessages(session.id);
    expect(messages.map((msg) => msg.id)).toEqual(['msg_1', 'msg_2']);
    expect(messages[0].content).toContain('WMS');
  });

  it('deletes a session without deleting long term memories', async () => {
    const session = await createChatSession();
    await saveChatMessage({
      id: 'msg_1',
      sessionId: session.id,
      role: 'user',
      content: '聊天记录',
      timestamp: 1,
    });
    await upsertUserMemory({ content: '用户偏好：不要写死业务路径。', type: 'preference' });

    await deleteChatSession(session.id);

    expect(await getChatSessionMessages(session.id)).toHaveLength(0);
    expect(await recallMemories('业务路径')).toHaveLength(1);
  });

  it('recalls enabled memories and builds bounded context', async () => {
    await upsertUserMemory({ content: '用户偏好：Computer Use 需要通用方案，不要硬编码菜单。', type: 'preference' });
    await upsertUserMemory({ content: '业务术语：库存预警位于饮片管理模块。', type: 'business_term' });

    const memories = await recallMemories('打开饮片管理库存预警');
    expect(memories.map((memory) => memory.type)).toContain('business_term');

    const context = await buildMemoryContext('Computer Use 库存预警');
    expect(context.contextText).toContain('以下是用户长期记忆');
    expect(context.contextText).toContain('库存预警');
  });

  it('does not recall memories when memory is disabled', async () => {
    await upsertUserMemory({ content: '用户偏好：保留 trace。' });
    await setMemoryEnabled(false);

    expect(await isMemoryEnabled()).toBe(false);
    expect(await recallMemories('trace')).toHaveLength(0);
    expect((await buildMemoryContext('trace')).contextText).toBe('');
  });

  it('rejects sensitive memory content', async () => {
    await expect(upsertUserMemory({ content: 'api_key = sk-1234567890abcdef1234567890' }))
      .rejects
      .toThrow('疑似敏感信息');
  });
});
