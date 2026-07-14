export class RuntimeMessageError extends Error {
  constructor(public code: 'RUNTIME_UNAVAILABLE' | 'EMPTY_RESPONSE' | 'RUNTIME_ERROR', message: string) {
    super(message);
    this.name = 'RuntimeMessageError';
  }
}

export function runtimeMessage<T>(payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      reject(new RuntimeMessageError('RUNTIME_UNAVAILABLE', '扩展后台不可用，请重新加载插件并刷新当前页面。'));
      return;
    }

    try {
      chrome.runtime.sendMessage(payload, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new RuntimeMessageError(
            'RUNTIME_ERROR',
            `${error.message || '扩展消息发送失败'}。请重新加载插件并刷新当前页面后重试。`,
          ));
          return;
        }
        if (response == null) {
          reject(new RuntimeMessageError(
            'EMPTY_RESPONSE',
            '扩展后台未返回响应。插件可能刚刚重新加载，请刷新当前设置页后重试。',
          ));
          return;
        }
        resolve(response as T);
      });
    } catch (error: any) {
      reject(new RuntimeMessageError(
        'RUNTIME_ERROR',
        `${error?.message || '扩展消息发送失败'}。请重新加载插件并刷新当前页面后重试。`,
      ));
    }
  });
}
