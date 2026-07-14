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

export async function uploadFileToLLM(file: File): Promise<NativeLLMFile> {
  const response = await chrome.runtime.sendMessage({
    type: 'UPLOAD_MODEL_FILE',
    file: {
      name: file.name,
      type: file.type,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
    },
  });
  if (!response?.success) throw new Error(response?.error || '模型文件上传失败');
  return response.file as NativeLLMFile;
}
