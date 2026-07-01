import React, { useState, useEffect, useRef } from 'react';
import { Input, Button, Form, Typography, message, Tabs, Spin } from 'antd';
import { 
  UserOutlined, 
  LockOutlined, 
  ThunderboltOutlined, 
  MobileOutlined,
  QrcodeOutlined,
  SafetyOutlined
} from '@ant-design/icons';
import { saveLoginSession } from '../../utils/auth';
import { initDingTalkQRCode, getUrlParam } from '../../utils/dingtalk';
import request from '../../utils/request';
import styles from './Login.module.scss';

const { Title, Text } = Typography;
const { TabPane } = Tabs;

interface AccountLoginValues {
  username: string;
  password: string;
}

interface PhoneLoginValues {
  phone: string;
  code: string;
}

const extractAuthToken = (data: any): string | null => {
  return data?.token || data?.accessToken || data?.authToken || null;
};

const extractUserInfo = (data: any): unknown => {
  return data?.userInfo || data?.user || data || null;
};

const Login: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [codeLoading, setCodeLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [activeTab, setActiveTab] = useState('account');
  const [qrCodeStatus, setQrCodeStatus] = useState<'loading' | 'ready' | 'scanned' | 'expired'>('loading');
  
  const accountForm = Form.useForm()[0];
  const phoneForm = Form.useForm()[0];
  const qrcodeContainerRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const completeLogin = async (responseData: any) => {
    const data = responseData?.data || responseData || {};
    await saveLoginSession({
      authToken: extractAuthToken(data),
      userInfo: extractUserInfo(data),
    });
    message.success('登录成功！');
  };

  // 生成钉钉二维码
  const generateDingTalkQRCode = async () => {
    setQrCodeStatus('loading');
    
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }

    if (qrcodeContainerRef.current && qrcodeContainerRef.current.innerHTML) {
      qrcodeContainerRef.current.innerHTML = '';
    }

    try {
      // 检查DDLogin是否已加载
      const checkDDLogin = () => {
        return new Promise<void>((resolve, reject) => {
          if (typeof window.DDLogin !== 'undefined') {
            resolve();
            return;
          }
          let attempts = 0;
          const maxAttempts = 50; // 最多等待5秒
          const interval = setInterval(() => {
            attempts++;
            if (typeof window.DDLogin !== 'undefined') {
              clearInterval(interval);
              resolve();
            } else if (attempts >= maxAttempts) {
              clearInterval(interval);
              reject(new Error('钉钉登录SDK加载超时，请检查ddLogin.js是否正确加载'));
            }
          }, 100);
        });
      };

      await checkDDLogin();

      // 等待dom渲染
      const waitForContainer = () => {
        return new Promise<void>((resolve, reject) => {
          const container = document.getElementById('dingtalk-qrcode-container');
          if (container) {
            resolve();
            return;
          }

          let attempts = 0;
          const maxAttempts = 50; 
          const interval = setInterval(() => {
            attempts++;
            const container = document.getElementById('dingtalk-qrcode-container');
            if (container) {
              clearInterval(interval);
              resolve();
            } else if (attempts >= maxAttempts) {
              clearInterval(interval);
              reject(new Error('容器元素未找到，请重试'));
            }
          }, 100);
        });
      };

      // 等待DOM更新
      await new Promise(resolve => setTimeout(resolve, 100));
      await waitForContainer();

      const redirectUri = 'http://sso-server-dev.igancao.cn/auth/oauth2/authorize'
      
      // 初始化钉钉二维码
      const cleanup = initDingTalkQRCode(
        'dingtalk-qrcode-container',
        redirectUri,
        async (loginTmpCode: string) => {
          setQrCodeStatus('scanned');
          try {
            await handleDingTalkLogin(loginTmpCode);
          } catch (error: any) {
            message.error(error.message || '登录失败，请重试');
            setQrCodeStatus('expired');
          }
        },
        (error: Error) => {
          message.error(error.message || '初始化失败，请重试');
          setQrCodeStatus('expired');
        }
      );

      cleanupRef.current = cleanup;
      setQrCodeStatus('ready');
    } catch (error: any) {
      setQrCodeStatus('expired');
      message.error(error.message || '生成二维码失败，请重试');
    }
  };

  // 钉钉扫码登录 - 生成二维码
  useEffect(() => {
    if (activeTab === 'dingtalk') {
      setTimeout(() => {
        generateDingTalkQRCode();
      }, 100);
    } else {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    }

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [activeTab]);

  useEffect(() => {
    const dingCode = getUrlParam('code');
    if (dingCode && activeTab === 'dingtalk') {
      handleDingTalkLogin(dingCode);
    }
  }, [activeTab]);

  // 账号密码登录
  const handleAccountLogin = async (values: AccountLoginValues) => {
    setLoading(true);
    try {
      if (values.username && values.password) {
        const formData = new URLSearchParams();
        formData.append('name', values.username);
        formData.append('pwd', values.password);
        const response = await request.post(
          '/auth/oauth2/doLogin',
          formData,
          {
            skipAuth: true,
            baseURL: 'https://sso-server-dev.igancao.cn',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          }
        );
        await completeLogin(response);
      } else {
        message.error('请输入用户名和密码');
      }
    } catch (error: any) {
      message.error(error.message || '登录失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  // 手机号登录
  const handlePhoneLogin = async (values: PhoneLoginValues) => {
    setLoading(true);
    try {
      if (values.phone && values.code) {
        const formData = new URLSearchParams();
        formData.append('phone', values.phone);
        formData.append('code', values.code);
        const response = await request.post(
          '/auth/oauth2/doLogin',
          formData,
          {
            skipAuth: true,
            baseURL: 'https://sso-server-dev.igancao.cn',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          }
        );
        
        await completeLogin(response);
      } else {
        message.error('请输入手机号和验证码');
      }
    } catch (error: any) {
      message.error(error.message || '登录失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  // 发送验证码
  const handleSendCode = async () => {
    const phone = phoneForm.getFieldValue('phone');
    if (!phone) {
      message.error('请先输入手机号');
      return;
    }
    
    const phoneRegex = /^1[3-9]\d{9}$/;
    if (!phoneRegex.test(phone)) {
      message.error('请输入正确的手机号');
      return;
    }

    setCodeLoading(true);
    try {
      const formData = new URLSearchParams();
      formData.append('phone', phone);
      
      const response = await request.post(
        '/auth/oauth2/sendCode',
        formData,
        {
          skipAuth: true,
          baseURL: 'https://sso-server-dev.igancao.cn',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );
      
      message.success('验证码已发送');
      setCountdown(60);
      const timer = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (error: any) {
      message.error(error.message || '发送验证码失败');
    } finally {
      setCodeLoading(false);
    }
  };

  // 钉钉扫码登录
  const handleDingTalkLogin = async (code: string) => {
    setLoading(true); 

    try {
      const formData = new URLSearchParams();
      formData.append('dingCode', code);
      const response = await request.post(
        '/auth/oauth2/doLogin',
        formData,
        {
          skipAuth: true,
          baseURL: 'https://sso-server-dev.igancao.cn', 
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );


      if (response.success || response.code === 200 || response.code === 0) {


        await completeLogin(response);
      } else {
        throw new Error(response.message || response.error || '登录失败');
      }
    } catch (error: any) {
      console.error('钉钉登录失败:', error);
      message.error(error.message || '登录失败，请重试');
      setQrCodeStatus('expired');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.loginContainer}>
      <div className={styles.backgroundDecoration} />
      
      <div className={styles.loginCard}>
        <div className={styles.logoWrapper}>
          <div className={styles.logoIcon}>
            <ThunderboltOutlined style={{ fontSize: '32px', color: '#6366f1' }} />
          </div>
          <Title level={3} className={styles.logoTitle}>
            甘草 Copliot
          </Title>
          <Text className={styles.logoSubtitle}>
            请登录以继续使用
          </Text>
        </div>

        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          className={styles.loginTabs}
          size="large"
        >
          {/* 账号密码登录 */}
          <TabPane
            tab={
              <span>
                <UserOutlined />
                账号密码
              </span>
            }
            key="account"
          >
            <Form
              form={accountForm}
              name="accountLogin"
              onFinish={handleAccountLogin}
              autoComplete="off"
              className={styles.loginForm}
              size="large"
            >
              <Form.Item
                name="username"
                rules={[
                  { required: true, message: '请输入用户名' },
                  { min: 3, message: '用户名至少3个字符' }
                ]}
              >
                <Input
                  prefix={<UserOutlined className={styles.inputIcon} />}
                  placeholder="用户名"
                  className={styles.input}
                />
              </Form.Item>

              <Form.Item
                name="password"
                rules={[
                  { required: true, message: '请输入密码' },
                  { min: 6, message: '密码至少6个字符' }
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined className={styles.inputIcon} />}
                  placeholder="密码"
                  className={styles.input}
                />
              </Form.Item>

              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={loading}
                  className={styles.loginButton}
                  block
                >
                  登录
                </Button>
              </Form.Item>
            </Form>
          </TabPane>

          {/* 手机号登录 */}
          <TabPane
            tab={
              <span>
                <MobileOutlined />
                手机号
              </span>
            }
            key="phone"
          >
            <Form
              form={phoneForm}
              name="phoneLogin"
              onFinish={handlePhoneLogin}
              autoComplete="off"
              className={styles.loginForm}
              size="large"
            >
              <Form.Item
                name="phone"
                rules={[
                  { required: true, message: '请输入手机号' },
                  { pattern: /^1[3-9]\d{9}$/, message: '请输入正确的手机号' }
                ]}
              >
                <Input
                  prefix={<MobileOutlined className={styles.inputIcon} />}
                  placeholder="手机号"
                  className={styles.input}
                  maxLength={11}
                />
              </Form.Item>

              <Form.Item
                name="code"
                rules={[
                  { required: true, message: '请输入验证码' },
                  { len: 4, message: '验证码为4位数字' }
                ]}
              >
                <div className={styles.codeInputWrapper}>
                  <Input
                    prefix={<SafetyOutlined className={styles.inputIcon} />}
                    placeholder="验证码"
                    className={styles.codeInput}
                    maxLength={6}
                  />
                  <Button
                    className={styles.sendCodeButton}
                    onClick={handleSendCode}
                    loading={codeLoading}
                    disabled={countdown > 0}
                  >
                    {countdown > 0 ? `${countdown}秒` : '发送验证码'}
                  </Button>
                </div>
              </Form.Item>

              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={loading}
                  className={styles.loginButton}
                  block
                >
                  登录
                </Button>
              </Form.Item>
            </Form>
          </TabPane>

          {/* 钉钉扫码登录 */}
          <TabPane
            tab={
              <span>
                <QrcodeOutlined />
                钉钉扫码
              </span>
            }
            key="dingtalk"
          >
            <div className={styles.qrcodeWrapper}>
              {qrCodeStatus === 'loading' && (
                <div className={styles.qrcodeLoading}>
                  <Spin size="large" />
                  <Text className={styles.qrcodeLoadingText}>正在生成二维码...</Text>
                </div>
              )}
              
              {/* 容器元素始终存在，但根据状态显示/隐藏 */}
              <div 
                ref={qrcodeContainerRef}
                id="dingtalk-qrcode-container"
                className={styles.qrcodeContainer}
                style={{ 
                  width: '250px', 
                  height: '300px',
                  margin: '0 auto',
                  display: qrCodeStatus === 'ready' ? 'flex' : 'none',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              />
              
              {qrCodeStatus === 'ready' && (
                <Text className={styles.qrcodeHint}>
                  请使用钉钉APP扫描二维码登录
                </Text>
              )}
              
              {qrCodeStatus === 'scanned' && (
                <div className={styles.qrcodeScanned}>
                  <Spin size="large" />
                  <Text className={styles.qrcodeScannedText}>扫码成功，正在登录...</Text>
                </div>
              )}
              
              {qrCodeStatus === 'expired' && (
                <div className={styles.qrcodeExpired}>
                  <Text className={styles.qrcodeExpiredText}>二维码已过期</Text>
                  <Button
                    type="primary"
                    onClick={generateDingTalkQRCode}
                    className={styles.refreshButton}
                  >
                    刷新二维码
                  </Button>
                </div>
              )}
            </div>
          </TabPane>
        </Tabs>

        <div className={styles.footer}>
          <Text className={styles.footerText}>
            登录即表示您同意使用本服务
          </Text>
        </div>
      </div>
    </div>
  );
};

export default Login;
