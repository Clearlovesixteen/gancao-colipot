/// <reference types="vite/client" />

declare module 'virtual:gancao-runtime-version' {
  export const RUNTIME_BUILD_ID: string;
}

declare module 'virtual:gancao-content-runtime-version' {
  export const RUNTIME_BUILD_ID: string;
}

declare module '*.module.scss' {
  const classes: { [key: string]: string };
  export default classes;
}

declare module '*.scss' {
  const content: { [key: string]: string };
  export default content;
}

declare module '@paddleocr/paddleocr-js' {
  export const PaddleOCR: {
    create(options?: Record<string, unknown>): Promise<{
      predict(input: unknown, params?: Record<string, unknown>): Promise<Array<{
        items?: Array<{
          text?: string;
          score?: number;
          poly?: Array<{ x?: number; y?: number } | [number, number]>;
        }>;
      }>>;
      dispose?: () => Promise<void>;
    }>;
  };
}
