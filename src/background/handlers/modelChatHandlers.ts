import type { ModelGateway } from '../modelGateway';

export function handleModelChatMessage(
  message: any,
  sendResponse: (response?: any) => void,
  deps: {
    modelGateway: ModelGateway;
    requireBusinessAuth: () => Promise<any | null>;
    initModelGatewayEvents: () => Promise<void>;
    resolveContextTabId: (requestedTabId?: number) => Promise<number | null>;
    buildId: string;
    isRuntimeVersionCurrent: (input: { buildId: string }) => boolean;
  },
): boolean {
  if (message.type === 'SEND_MESSAGE') {
    (async () => {
      try {
        const authError = await deps.requireBusinessAuth();
        if (authError) {
          sendResponse(authError);
          return;
        }
        await deps.initModelGatewayEvents();
        const contextTabId = await deps.resolveContextTabId(message.contextTabId);
        const result = await deps.modelGateway.send(
          message.messageHistory || [],
          message.requestId,
          message.memoryContext,
          message.modelProfileId,
          contextTabId || undefined,
        );
        sendResponse({ ...result, error: result.success ? undefined : result.error || 'AI 请求失败' });
      } catch (error: any) {
        sendResponse({ success: false, code: error?.code, error: error?.message || 'AI 请求失败' });
      }
    })();
    return true;
  }
  if (message.type === 'STOP_AI_MESSAGE') {
    sendResponse(deps.modelGateway.cancel());
    return true;
  }
  if (message.type === 'GET_STATUS') {
    const compatible = deps.isRuntimeVersionCurrent({ buildId: String(message.clientBuildId || '') });
    sendResponse({
      status: deps.modelGateway.getStatus(),
      buildId: deps.buildId,
      compatible,
      code: compatible ? undefined : 'EXTENSION_RUNTIME_MISMATCH',
    });
    return true;
  }
  return false;
}
