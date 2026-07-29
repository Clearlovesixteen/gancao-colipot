import { describe, expect, it } from 'vitest';
import { shouldStopTypingForGatewayStatus } from './chatRequestState';

describe('shouldStopTypingForGatewayStatus', () => {
  it('模型连接成功不应提前隐藏生成中状态', () => {
    expect(shouldStopTypingForGatewayStatus('connected')).toBe(false);
    expect(shouldStopTypingForGatewayStatus('connecting')).toBe(false);
  });

  it('连接失败或断开时结束生成中状态', () => {
    expect(shouldStopTypingForGatewayStatus('error')).toBe(true);
    expect(shouldStopTypingForGatewayStatus('disconnected')).toBe(true);
  });
});
