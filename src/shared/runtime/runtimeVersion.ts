import { RUNTIME_BUILD_ID as bundledBuildId } from 'virtual:gancao-runtime-version';

export const RUNTIME_BUILD_ID = bundledBuildId;

export type RuntimeContext = 'background' | 'content' | 'sidePanel' | 'dashboard';

export interface RuntimeVersionInfo {
  buildId: string;
  context: RuntimeContext;
  url?: string;
}

export function isRuntimeVersionCurrent(info: Pick<RuntimeVersionInfo, 'buildId'> | null | undefined): boolean {
  return Boolean(info?.buildId && info.buildId === RUNTIME_BUILD_ID);
}

export function runtimeMismatchMessage(actualBuildId?: string): string {
  return `扩展运行版本不一致（当前 ${RUNTIME_BUILD_ID}，页面 ${actualBuildId || '未知'}），已停止使用旧代码。请刷新页面后重试。`;
}
