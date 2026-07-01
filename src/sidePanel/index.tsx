import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// 引入 Antd 样式 (Antd 4 需要手动引入样式，Antd 5 则是 css-in-js)
import 'antd/dist/antd.css';

const container = document.getElementById('root');
if (!container) {
  console.error('Root container not found!');
} else {
  try {
    const root = createRoot(container);
    root.render(<App />);
   
  } catch (error) {
    console.error('加载React 应用失败:', error);
  }
}