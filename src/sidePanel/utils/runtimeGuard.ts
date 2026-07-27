import { RUNTIME_BUILD_ID } from '../../shared/runtimeVersion';

export interface PackagedBuildInfo {
  buildId?: string;
}

export function isPackagedBuildCurrent(info: PackagedBuildInfo | null | undefined): boolean {
  return Boolean(info?.buildId && info.buildId === RUNTIME_BUILD_ID);
}

export async function readPackagedBuildInfo(): Promise<PackagedBuildInfo> {
  const resourceUrl = chrome.runtime.getURL('build-info.json');
  const response = await fetch(`${resourceUrl}?time=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`读取扩展构建信息失败：HTTP ${response.status}`);
  }
  return await response.json() as PackagedBuildInfo;
}

export async function ensurePackagedBuildCurrent(): Promise<'current' | 'reloading'> {
  const info = await readPackagedBuildInfo();
  if (isPackagedBuildCurrent(info)) return 'current';

  // An unpacked extension does not reload automatically after dist changes.
  // Stop the old runtime instead of allowing it to execute against new files.
  window.setTimeout(() => chrome.runtime.reload(), 80);
  return 'reloading';
}
