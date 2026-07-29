const AUTH_STORAGE_KEY = 'user_auth';
const USERNAME_STORAGE_KEY = 'plugIn_userInfo';

export interface AuthState {
  isAuthenticated: boolean;
  userInfo: unknown | null;
}

interface LoginSession {
  userInfo?: unknown;
  authToken?: string | null;
}

// 检查用户登录
export async function isAuthenticated(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve(false);
      return;
    }
    chrome.storage.local.get([AUTH_STORAGE_KEY], (result) => {
      resolve(result[AUTH_STORAGE_KEY] === true);
    });
  });
}

// 获取当前登录的用户信息
export async function getUsername(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve(null);
      return;
    }
    chrome.storage.local.get([USERNAME_STORAGE_KEY], (result) => {
      resolve(result[USERNAME_STORAGE_KEY] || null);
    });
  });
}

// 保存完整登录态
export async function saveLoginSession(session: LoginSession): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!chrome?.storage?.local) {
      resolve();
      return;
    }

    const userInfo = session.userInfo ?? null;
    const nextAuthState: Record<string, unknown> = {
      [AUTH_STORAGE_KEY]: true,
      [USERNAME_STORAGE_KEY]: userInfo,
      userInfo,
      authSource: 'plugin',
      pageAuthLastLogoutReason: null,
    };

    if (session.authToken) {
      nextAuthState.authToken = session.authToken;
      nextAuthState.dingtalkToken = session.authToken;
    }

    chrome.storage.local.set(
      nextAuthState,
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      }
    );
  });
}

// 登录
export async function saveUserInfo(userInfo: object): Promise<void> {
  await saveLoginSession({ userInfo });
}

// 登出
export async function logout(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!chrome?.storage?.local) {
      reject(new Error('Chrome storage API is not available'));
      return;
    }
    chrome.storage.local.set({ [AUTH_STORAGE_KEY]: false }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      chrome.storage.local.remove([
        USERNAME_STORAGE_KEY,
        'userInfo',
        'dingtalkToken',
        'authToken',
        'authSource',
        'pageAuthSnapshot',
        'pageAuthHost',
        'pageAuthLastLogoutReason',
      ], () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  });
}


// 获取用户信息
export async function getAuthState(): Promise<AuthState> {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve({
        isAuthenticated: false,
        userInfo: null,
      });
      return;
    }
    chrome.storage.local.get([AUTH_STORAGE_KEY, USERNAME_STORAGE_KEY], (result) => {
      resolve({
        isAuthenticated: result[AUTH_STORAGE_KEY] === true,
        userInfo: result[USERNAME_STORAGE_KEY] || null,
      });
    });
  });
}
