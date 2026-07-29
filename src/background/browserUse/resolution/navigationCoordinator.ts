import { isTransientNavigationMessagingError } from '../messaging/browserMessagingErrors';

export interface NavigationAwareActionResult<T = unknown> {
  result: T | { success: true; navigationPending: true; warning: string };
  channelTransition: boolean;
  warning?: string;
}

export async function executeNavigationAwareAction<T>(input: {
  mayNavigate: boolean;
  execute: () => Promise<T>;
  synchronize?: () => Promise<void>;
  settleMs?: number;
}): Promise<NavigationAwareActionResult<T>> {
  let result: NavigationAwareActionResult<T>['result'];
  let channelTransition = false;
  let warning: string | undefined;

  try {
    result = await input.execute();
  } catch (error) {
    if (!input.mayNavigate || !isTransientNavigationMessagingError(error)) throw error;
    channelTransition = true;
    warning = '页面导航期间消息通道已切换，正在通过目标页面状态校验动作结果';
    result = { success: true, navigationPending: true, warning };
  }

  if (input.mayNavigate && input.synchronize) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, input.settleMs ?? 150)));
    await input.synchronize();
  }

  return { result, channelTransition, warning };
}
