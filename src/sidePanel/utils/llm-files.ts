const LLM_API_KEY = 'sk-9e78d63ce4ca08291b35c19caf1379892a8b9a40d3e856cc85def65d049c5b1f';
const LLM_BASE_URL = 'https://api.86gamestore.com/v1';

export interface NativeLLMFile {
  id: string;
  name: string;
  type: string;
  size: number;
  purpose?: string;
  status?: string;
  createdAt?: number;
  raw?: Record<string, any>;
}

const FILE_UPLOAD_PURPOSES = ['user_data', 'assistants'];

function getUploadErrorText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const record = data as Record<string, any>;
  return (
    record.error?.message ||
    record.message ||
    record.msg ||
    record.error ||
    ''
  ).toString();
}

function normalizeNativeFileResponse(data: any, file: File, purpose: string): NativeLLMFile {
  const id = data?.id || data?.file_id || data?.data?.id || data?.data?.file_id;

  if (!id || typeof id !== 'string') {
    throw new Error('文件上传成功但未返回 file_id');
  }

  return {
    id,
    name: data?.filename || data?.name || file.name,
    type: file.type || 'application/octet-stream',
    size: data?.bytes || data?.size || file.size,
    purpose: data?.purpose || purpose,
    status: data?.status,
    createdAt: data?.created_at,
    raw: data,
  };
}

async function uploadWithPurpose(file: File, purpose: string): Promise<NativeLLMFile> {
  const formData = new FormData();
  formData.append('file', file, file.name);
  formData.append('purpose', purpose);

  const response = await fetch(`${LLM_BASE_URL}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: formData,
  });

  const responseText = await response.text();
  let data: any = null;

  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = responseText;
    }
  }

  if (!response.ok) {
    const message = getUploadErrorText(data) || responseText || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return normalizeNativeFileResponse(data, file, purpose);
}

export async function uploadFileToLLM(file: File): Promise<NativeLLMFile> {
  const errors: string[] = [];

  for (const purpose of FILE_UPLOAD_PURPOSES) {
    try {
      return await uploadWithPurpose(file, purpose);
    } catch (error: any) {
      errors.push(`${purpose}: ${error?.message || '上传失败'}`);
    }
  }

  throw new Error(errors.join('; '));
}
