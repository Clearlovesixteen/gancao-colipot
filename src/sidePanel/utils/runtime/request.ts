export interface RequestConfig extends RequestInit {
  timeout?: number; 
  baseURL?: string;
  params?: Record<string, any>; 
  skipAuth?: boolean;  //自动添加token
  skipErrorHandler?: boolean; //是否要添加统一错误处理
}

export interface ResponseData<T = any> {
  code?: number;
  success?: boolean;
  data?: T;
  message?: string;
  error?: string;
  [key: string]: any;
}


type RequestInterceptor = (config: RequestConfig) => RequestConfig | Promise<RequestConfig>;


type ResponseInterceptor = <T = any>(response: Response, data: ResponseData<T>) => ResponseData<T> | Promise<ResponseData<T>>;


type ErrorInterceptor = (error: Error, response?: Response) => Promise<never> | void;

class Request {
  private baseURL: string = '';
  private timeout: number = 30000; 
  private requestInterceptors: RequestInterceptor[] = [];
  private responseInterceptors: ResponseInterceptor[] = [];
  private errorInterceptors: ErrorInterceptor[] = [];
  
  setBaseURL(url: string) {
    this.baseURL = url;
    return this;
  }

  //设置默认超时时间
  setTimeout(timeout: number) {
    this.timeout = timeout;
    return this;
  }

  //添加请求拦截器
  addRequestInterceptor(interceptor: RequestInterceptor) {
    this.requestInterceptors.push(interceptor);
    return this;
  }

  // 添加响应拦截器
  addResponseInterceptor(interceptor: ResponseInterceptor) {
    this.responseInterceptors.push(interceptor);
    return this;
  }

  //添加错误拦截器
  addErrorInterceptor(interceptor: ErrorInterceptor) {
    this.errorInterceptors.push(interceptor);
    return this;
  }

  //执行请求拦截器
  private async executeRequestInterceptors(config: RequestConfig): Promise<RequestConfig> {
    let finalConfig = { ...config };
    for (const interceptor of this.requestInterceptors) {
      finalConfig = await interceptor(finalConfig);
    }
    return finalConfig;
  }

  // 执行响应拦截器
  private async executeResponseInterceptors<T>(
    response: Response,
    data: ResponseData<T>
  ): Promise<ResponseData<T>> {
    let finalData = data;
    for (const interceptor of this.responseInterceptors) {
      finalData = await interceptor(response, finalData);
    }
    return finalData;
  }

  // 执行错误拦截器
  private async executeErrorInterceptors(error: Error, response?: Response): Promise<never> {
    for (const interceptor of this.errorInterceptors) {
      const result = await interceptor(error, response);
      if (result !== undefined) {
        throw result;
      }
    }
    throw error;
  }

  // 优先使用传入的baseURL，否则使用实例的baseURL
  private buildURL(url: string, params?: Record<string, any>, baseURL?: string): string {

    const effectiveBaseURL = baseURL || this.baseURL;
    let fullURL = url.startsWith('http') ? url : `${effectiveBaseURL}${url}`;
    
    if (params) {
      const searchParams = new URLSearchParams();
      Object.keys(params).forEach((key) => {
        const value = params[key];
        if (value !== null && value !== undefined) {
          if (Array.isArray(value)) {
            value.forEach((v) => searchParams.append(key, String(v)));
          } else {
            searchParams.append(key, String(value));
          }
        }
      });
      const queryString = searchParams.toString();
      if (queryString) {
        fullURL += (fullURL.includes('?') ? '&' : '?') + queryString;
      }
    }
    
    return fullURL;
  }

  // 创建带超时的fetch请求
  private createFetchWithTimeout(url: string, config: RequestConfig): Promise<Response> {
    const { timeout = this.timeout } = config;
    
    return Promise.race([
      fetch(url, config),
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error(`请求超时 (${timeout}ms)`)), timeout)
      ),
    ]);
  }

  // 获取默认headers
  private getDefaultHeaders(): HeadersInit {
    return {
      'Content-Type': 'application/json',
    };
  }

  // 取token
  private async getAuthToken(): Promise<string | null> {
    return new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve(null);
        return;
      }
      chrome.storage.local.get(['dingtalkToken', 'authToken'], (result) => {
        resolve(result.dingtalkToken || result.authToken || null);
      });
    });
  }

  private async request<T = any>(url: string, config: RequestConfig = {}): Promise<ResponseData<T>> {
    try {
      // 执行请求拦截器
      let finalConfig = await this.executeRequestInterceptors(config);

      const fullURL = this.buildURL(url, finalConfig.params, finalConfig.baseURL);

      const headers = new Headers(this.getDefaultHeaders());
      if (finalConfig.headers) {
        if (finalConfig.headers instanceof Headers) {
          finalConfig.headers.forEach((value, key) => {
            headers.set(key, value);
          });
        } else if (Array.isArray(finalConfig.headers)) {
          finalConfig.headers.forEach(([key, value]) => {
            headers.set(key, value);
          });
        } else {
          Object.entries(finalConfig.headers).forEach(([key, value]) => {
            if (value) {
              headers.set(key, String(value));
            }
          });
        }
      }

      if (!finalConfig.skipAuth) {
        const token = await this.getAuthToken();
        if (token) {
          headers.set('Authorization', `Bearer ${token}`);
        }
      }

      // 处理body
      let body = finalConfig.body;
      if (body !== null && body !== undefined) {
        const contentType = headers.get('Content-Type');
        
        // 如果是对象且Content-Type是application/json，则序列化为JSON字符串
        if (typeof body === 'object' && 
            !(body instanceof FormData) && 
            !(body instanceof Blob) && 
            !(body instanceof ArrayBuffer) &&
            !(body instanceof URLSearchParams)) {
          if (contentType?.includes('application/json')) {
            body = JSON.stringify(body);
          }
        }
      }

      // 创建请求配置
      const requestConfig: RequestInit = {
        ...finalConfig,
        headers,
        body,
      };

      
      const response = await this.createFetchWithTimeout(fullURL, requestConfig);

      // 检查响应状态
      if (!response.ok) {
        const errorText = await response.text();
        let errorData: any;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { message: errorText || `HTTP ${response.status} ${response.statusText}` };
        }
        
        const error = new Error(errorData.message || errorData.error || `请求失败: ${response.status}`);
        (error as any).status = response.status;
        (error as any).data = errorData;
        
        if (!finalConfig.skipErrorHandler) {
          await this.executeErrorInterceptors(error, response);
        }
        throw error;
      }

      // 解析响应数据
      const contentType = response.headers.get('content-type');
      let data: ResponseData<T>;
      
      if (contentType?.includes('application/json')) {
        data = await response.json();
      } else {
        const text = await response.text();
        try {
          data = JSON.parse(text);
        } catch {
          data = { data: text } as ResponseData<T>;
        }
      }

      // 执行响应拦截器
      data = await this.executeResponseInterceptors(response, data);

      // 检查业务状态码
      if (data.code !== undefined && data.code !== 200 && data.code !== 0) {
        const error = new Error(data.message || data.error || '请求失败');
        (error as any).code = data.code;
        (error as any).data = data;
        
        if (!finalConfig.skipErrorHandler) {
          await this.executeErrorInterceptors(error, response);
        }
        throw error;
      }

      return data;
    } catch (error: any) {
      // 处理网络错误等
      if (!config.skipErrorHandler) {
        await this.executeErrorInterceptors(error);
      }
      throw error;
    }
  }


  get<T = any>(url: string, config?: RequestConfig): Promise<ResponseData<T>> {
    return this.request<T>(url, {
      ...config,
      method: 'GET',
    });
  }

  post<T = any>(url: string, data?: any, config?: RequestConfig): Promise<ResponseData<T>> {
    return this.request<T>(url, {
      ...config,
      method: 'POST',
      body: data,
    });
  }

  put<T = any>(url: string, data?: any, config?: RequestConfig): Promise<ResponseData<T>> {
    return this.request<T>(url, {
      ...config,
      method: 'PUT',
      body: data,
    });
  }

  
  delete<T = any>(url: string, config?: RequestConfig): Promise<ResponseData<T>> {
    return this.request<T>(url, {
      ...config,
      method: 'DELETE',
    });
  }

  
  patch<T = any>(url: string, data?: any, config?: RequestConfig): Promise<ResponseData<T>> {
    return this.request<T>(url, {
      ...config,
      method: 'PATCH',
      body: data,
    });
  }

  upload<T = any>(url: string, file: File | FormData, config?: RequestConfig): Promise<ResponseData<T>> {
    const formData = file instanceof FormData ? file : new FormData();
    if (file instanceof File) {
      formData.append('file', file);
    }

    return this.request<T>(url, {
      ...config,
      method: 'POST',
      body: formData,
      skipAuth: config?.skipAuth,
    });
  }
}

// 初始化实例
const request = new Request();

// 请求拦截器
request.addRequestInterceptor(async (config) => {
  return config;
});

// 响应拦截器，主要可以处理把status逻辑放在这
request.addResponseInterceptor(async (response, data) => {
  return data;
});

// 错误拦截器
request.addErrorInterceptor(async (error: any) => {
  if (error.status === 401) {
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ user_auth: false }, () => {
        chrome.storage.local.remove([
          'plugIn_userInfo',
          'userInfo',
          'dingtalkToken',
          'authToken',
          'authSource',
          'pageAuthSnapshot',
          'pageAuthHost',
          'pageAuthLastLogoutReason',
        ]);
      });
    }
  }
  throw error;
});

export default request;

export { Request };
