export interface ModelMessage {
  id: string;
  content: string;
  type: 'user' | 'system' | 'assistant';
  timestamp: number;
  requestId?: string;
  delivery?: 'streaming' | 'tool' | 'final';
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, any>;
  }>;
}

export interface NativeFileReference {
  id: string;
  name?: string;
  type?: string;
  size?: number;
}

