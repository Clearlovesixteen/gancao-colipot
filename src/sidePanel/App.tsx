import React, { useState, useEffect } from 'react';
import { Spin } from 'antd';
import Chat from './components/Chat';
import Login from './components/Login';
import { isAuthenticated } from './utils/auth';

const App: React.FC = () => {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    if (!chrome?.storage?.local) {
      return;
    }

    const requestPageAuthSync = () => {
      if (!chrome?.runtime?.sendMessage) return;

      chrome.runtime.sendMessage({ type: 'REQUEST_PAGE_AUTH_SYNC' }, () => {
        if (chrome.runtime.lastError) {
          console.warn('请求页面登录态失败:', chrome.runtime.lastError.message);
        }
      });
    };

    const checkAuth = async () => {
      const authStatus = await isAuthenticated();
      setAuthenticated(authStatus);
      requestPageAuthSync();
    };
    
    checkAuth();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestPageAuthSync();
      }
    };

    const handleWindowFocus = () => {
      requestPageAuthSync();
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
  }, []);

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
