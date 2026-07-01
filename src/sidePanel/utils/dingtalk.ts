//环境配置
const DINGTALK_CONFIG = {
  PROD_APPID: 'dingoavg2zhhsh91w3vejj', //生产
 
  TEST_APPID: 'dingoa9c91tn8hsf2k0ydi', //测试

  CORP_ID: 'dingb07782d6576e4ea7', //企业的corpId
};

// 声明全局DDLogin类型
declare global {
  interface Window {
    DDLogin: (config: {
      id: string;
      goto: string;
      style?: string;
      width?: string;
      height?: string;
    }) => any;
  }
}


export function getDingTalkAppId(): string {

  if (typeof window !== 'undefined' && window.location.href.indexOf('sso-server.gancao.com') >= 0) {
    return DINGTALK_CONFIG.PROD_APPID;
  }
  return DINGTALK_CONFIG.TEST_APPID;
}


export function getUrlParam(name: string): string | null {
  const reg = new RegExp('(^|&)' + name + '=([^&]*)(&|$)', 'i');
  const r = window.location.search.substr(1).match(reg);
  if (r != null) return decodeURIComponent(r[2]);
  return null;
}

//初始化
export function initDingTalkQRCode(
  containerId: string,
  redirectUri: string,
  onSuccess: (loginTmpCode: string) => void,
  onError?: (error: Error) => void
): () => void {

  
  // 检查DDLogin是否已加载
  if (typeof window.DDLogin === 'undefined') {
    const error = new Error('钉钉登录SDK脚本不存在');
    console.error(error);
    if (onError) {
      onError(error);
    }
    return () => {};
  }
  
  const container = document.getElementById(containerId);
  if (!container) {
    const error = new Error(`容器元素不存在`);
    if (onError) {
      onError(error);
    }
    return () => {};
  }
  
  try {
    const appid = getDingTalkAppId();
    const url = encodeURIComponent(redirectUri);
    console.log(appid,url,'13123')
    const goto = `https://oapi.dingtalk.com/connect/oauth2/sns_authorize?appid=${appid}&response_type=code&scope=snsapi_login&state=STATE&redirect_uri=${url}`;
    const gotoEncode = encodeURIComponent(goto);

    const obj = window.DDLogin({
      id: containerId,
      goto: gotoEncode,
      style: 'border:none;background-color:#FFFFFF;',
      width: '250',
      height: '300',
    });

    // 存储二次跳转标签页ID
    let authTabId: number | null = null;
    
    const handleDingTalkAuthMessage = (message: any) => {
      if (message.type === 'DINGTALK_AUTH_CODE' && message.code) {

        if (chrome?.runtime?.onMessage) {
          chrome.runtime.onMessage.removeListener(handleDingTalkAuthMessage);
        }
        
        if (authTabId && chrome?.tabs?.remove) {
          chrome.tabs.remove(authTabId).catch(() => {});
          authTabId = null;
        }
        
        onSuccess(message.code);
      } else if (message.type === 'DINGTALK_AUTH_ERROR') {

        if (chrome?.runtime?.onMessage) {
          chrome.runtime.onMessage.removeListener(handleDingTalkAuthMessage);
        }
        
        if (authTabId && chrome?.tabs?.remove) {
          chrome.tabs.remove(authTabId).catch(() => {});
          authTabId = null;
        }
        
        // 调用错误回调
        if (onError) {
          onError(new Error(message.error || '授权失败'));
        }
      }
    };

    // 添加消息监听器
    if (chrome?.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(handleDingTalkAuthMessage);
    }

    // 监听postMessage
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
     
      
      if (origin === 'https://login.dingtalk.com') {
        const loginTmpCode = event.data;
       
        
        if (loginTmpCode && typeof loginTmpCode === 'string') {
          
          const fullAuthUrl = `${goto}&loginTmpCode=${loginTmpCode}`;
        // 插件环境window.location.href 改变不了路由，所以用createTab
          if (chrome?.tabs?.create) {
            chrome.tabs.create({ url: fullAuthUrl }, (tab) => {
              if (tab?.id) {
                authTabId = tab.id;
                chrome.runtime?.sendMessage?.({
                  type: 'TRACK_DINGTALK_AUTH_TAB',
                  tabId: tab.id,
                }).catch(() => {});
              }
            });
          } else {
            if (onError) {
              onError(new Error('无法打开授权页面'));
            }
          }
        }
      }
    };

    // 添加事件监听
    if (typeof window.addEventListener !== 'undefined') {
      window.addEventListener('message', handleMessage, false);
    } else if (typeof (window as any).attachEvent !== 'undefined') {
      (window as any).attachEvent('onmessage', handleMessage);
    }

    // 返回清理函数
    return () => {
      
      if (typeof window.removeEventListener !== 'undefined') {
        window.removeEventListener('message', handleMessage, false);
      } else if (typeof (window as any).detachEvent !== 'undefined') {
        (window as any).detachEvent('onmessage', handleMessage);
      }
      
      
      if (chrome?.runtime?.onMessage) {
        try {
          chrome.runtime.onMessage.removeListener(handleDingTalkAuthMessage);
        } catch (e) {
         
        }
      }
      
      
      if (authTabId && chrome?.tabs?.remove) {
        chrome.tabs.remove(authTabId).catch(() => {});
        authTabId = null;
      }
    };
  } catch (error: any) {
   
    if (onError) {
      onError(error);
    }
    return () => {};
  }
}

