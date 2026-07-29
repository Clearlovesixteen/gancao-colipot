import type { ModelGateway } from '../model/modelGateway';
import { handleAutomationTaskMessage } from './automationTaskHandlers';
import { handleAuthBridgeMessage } from './authBridgeHandlers';
import { handleModelChatMessage } from './modelChatHandlers';
import { handleModelProfileMessage } from './modelProfileHandlers';
import { handlePageToolMessage } from './pageToolHandlers';
import { handlePageContextActionMessage } from './pageContextActionHandler';

const VERSIONED_MESSAGE_TYPES = new Set([
  'SEND_MESSAGE',
  'RUN_AUTOMATION_TASK',
  'STOP_AUTOMATION_TASK',
  'RETRY_AUTOMATION_TASK',
]);

export function createBackgroundMessageRouter(deps: {
  modelGateway: ModelGateway;
  buildId: string;
  isRuntimeVersionCurrent: (input: { buildId: string }) => boolean;
  runtimeMismatchMessage: (buildId?: string) => string;
  automation: Parameters<typeof handleAutomationTaskMessage>[2];
  auth: Parameters<typeof handleAuthBridgeMessage>[3];
  modelChat: Omit<Parameters<typeof handleModelChatMessage>[2], 'modelGateway' | 'buildId' | 'isRuntimeVersionCurrent'>;
  pageTools: Parameters<typeof handlePageToolMessage>[3];
  confirmBrowserUseAction: (message: any, sendResponse: (response?: any) => void) => boolean;
}) {
  return (
    message: any,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void,
  ): boolean => {
    if (
      VERSIONED_MESSAGE_TYPES.has(message.type)
      && !deps.isRuntimeVersionCurrent({ buildId: String(message.clientBuildId || '') })
    ) {
      sendResponse({
        success: false,
        code: 'EXTENSION_RUNTIME_MISMATCH',
        error: deps.runtimeMismatchMessage(message.clientBuildId),
        buildId: deps.buildId,
      });
      return false;
    }

    if (handleModelProfileMessage(message, sendResponse, deps.modelGateway)) return true;
    if (handleAutomationTaskMessage(message, sendResponse, deps.automation)) return true;
    if (handleAuthBridgeMessage(message, sender, sendResponse, deps.auth)) return true;
    if (handleModelChatMessage(message, sendResponse, {
      ...deps.modelChat,
      modelGateway: deps.modelGateway,
      buildId: deps.buildId,
      isRuntimeVersionCurrent: deps.isRuntimeVersionCurrent,
    })) return true;
    if (handlePageToolMessage(message, sender, sendResponse, deps.pageTools)) return true;
    if (handlePageContextActionMessage(message, sender, sendResponse)) return true;
    if (message.type === 'CONFIRM_COMPUTER_USE_ACTION') {
      return deps.confirmBrowserUseAction(message, sendResponse);
    }
    return false;
  };
}
