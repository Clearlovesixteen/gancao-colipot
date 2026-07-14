import type { ModelGateway } from '../modelGateway';
import {
  deleteModelProfile,
  listModelProfiles,
  setActiveModelProfile,
  toPublicModelProfile,
  upsertModelProfile,
  type ModelProfile,
} from '../../shared/modelProfiles';
import { toAppErrorPayload } from '../../shared/appErrors';

type SendResponse = (response: unknown) => void;

async function resolveProfileInput(input: Partial<ModelProfile>): Promise<ModelProfile> {
  const existing = input.id
    ? (await listModelProfiles()).find((profile) => profile.id === input.id)
    : undefined;
  return {
    ...(existing || {}),
    ...input,
    apiKey: input.apiKey && !input.apiKey.includes('•') ? input.apiKey : existing?.apiKey || '',
  } as ModelProfile;
}

export function handleModelProfileMessage(
  message: any,
  sendResponse: SendResponse,
  gateway: ModelGateway,
): boolean {
  if (message.type === 'GET_MODEL_PROFILES') {
    listModelProfiles()
      .then((profiles) => sendResponse({ success: true, profiles: profiles.map(toPublicModelProfile) }))
      .catch((error) => sendResponse(toAppErrorPayload(error, '读取模型配置失败')));
    return true;
  }

  if (message.type === 'UPSERT_MODEL_PROFILE') {
    (async () => {
      const profile = await upsertModelProfile(message.profile || {});
      gateway.invalidate();
      sendResponse({ success: true, profile: toPublicModelProfile(profile) });
    })().catch((error) => sendResponse(toAppErrorPayload(error, '保存模型配置失败')));
    return true;
  }

  if (message.type === 'SET_ACTIVE_MODEL_PROFILE') {
    (async () => {
      await setActiveModelProfile(String(message.id || ''));
      gateway.invalidate();
      sendResponse({ success: true });
    })().catch((error) => sendResponse(toAppErrorPayload(error, '切换模型失败')));
    return true;
  }

  if (message.type === 'TEST_MODEL_PROFILE') {
    (async () => {
      const profile = await resolveProfileInput(message.profile || {});
      await gateway.test(profile);
      sendResponse({ success: true });
    })().catch((error) => sendResponse(toAppErrorPayload(error, '连接测试失败')));
    return true;
  }

  if (message.type === 'DELETE_MODEL_PROFILE') {
    (async () => {
      await deleteModelProfile(String(message.id || ''));
      gateway.invalidate();
      sendResponse({ success: true });
    })().catch((error) => sendResponse(toAppErrorPayload(error, '删除模型配置失败')));
    return true;
  }

  if (message.type === 'UPLOAD_MODEL_FILE') {
    gateway.uploadFile(message.file || {})
      .then((file) => sendResponse({ success: true, file }))
      .catch((error) => sendResponse(toAppErrorPayload(error, '模型文件上传失败')));
    return true;
  }

  return false;
}
