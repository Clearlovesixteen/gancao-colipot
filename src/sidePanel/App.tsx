import React, { useState, useEffect } from 'react';
import { Spin } from 'antd';
import Chat from './components/Chat';
import Login from './components/Login';
import { isAuthenticated } from './utils/auth/auth';
import { ensurePackagedBuildCurrent } from './utils/runtime/runtimeGuard';

const App: React.FC = () => {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [runtimeState, setRuntimeState] = useState<'checking' | 'current' | 'reloading' | 'error'>('checking');

  useEffect(() => {
    let cancelled = false;

    ensurePackagedBuildCurrent()
      .then((state) => {
        if (!cancelled) setRuntimeState(state);
      })
      .catch((error) => {
        console.error('检查扩展运行版本失败:', error);
        if (!cancelled) setRuntimeState('error');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (runtimeState !== 'current') return;
    if (!chrome?.storage?.local) {
      return;
    }

    const requestPageAuthSync = async (): Promise<void> => {
      if (!chrome?.runtime?.sendMessage) return;
      try {
        await chrome.runtime.sendMessage({ type: 'REQUEST_PAGE_AUTH_SYNC' });
      } catch (error: any) {
        console.warn('请求页面登录态失败:', error?.message || error);
      }
    };

    const checkAuth = async () => {
      await requestPageAuthSync();
      const authStatus = await isAuthenticated();
      setAuthenticated(authStatus);
    };
    
    checkAuth();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestPageAuthSync().catch(() => {});
      }
    };

    const handleWindowFocus = () => {
      requestPageAuthSync().catch(() => {});
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);

    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes.user_auth) {
        setAuthenticated(changes.user_auth.newValue === true);
      }
    };

    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(handleStorageChange);

      return () => {
        chrome.storage.onChanged?.removeListener(handleStorageChange);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('focus', handleWindowFocus);
      };
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [runtimeState]);

  if (runtimeState !== 'current') {
    const runtimeMessage = runtimeState === 'reloading'
      ? '检测到新构建，正在重新加载插件...'
      : runtimeState === 'error'
        ? '无法校验插件构建版本，请重新加载扩展'
        : '正在校验插件版本...';
    return (
      <div style={{
        height: '100vh',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f8fafc',
        color: '#475569',
      }}>
        {runtimeState !== 'error' && <Spin size="large" />}
        <span>{runtimeMessage}</span>
      </div>
    );
  }

  if (authenticated === null) {
    return (
      <div style={{ 
        height: '100vh', 
        width: '100%', 
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f8fafc'
      }}>
        <Spin size="large" />
      </div>
    );
  }
  
  return (
    <div style={{ 
      height: '100%', 
      width: '100%', 
      minHeight: '100vh',
      backgroundColor: '#fff'
    }}>
      {authenticated ? <Chat /> : <Login />}
    </div>
  );
};

export default App;
