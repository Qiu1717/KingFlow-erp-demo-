import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
// antd v5 官方 React 19 兼容补丁：必须在 antd 之前导入，否则弹窗、消息等
// 依赖 ReactDOM.render 的组件会失效并在控制台输出兼容性警告。
import '@ant-design/v5-patch-for-react-19';
import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { queryClient } from './app/query';
import { Application } from './app/App';
import 'antd/dist/reset.css';
import './styles/global.css';
import './styles/mobile.css';
dayjs.locale('zh-cn');
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      button={{ autoInsertSpace: false }}
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#1677ff',
          colorText: '#1f2937',
          colorTextSecondary: '#64748b',
          colorBgLayout: '#f5f7fa',
          colorBorderSecondary: '#e5e7eb',
          borderRadius: 8,
          fontSize: 13,
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
          controlHeight: 36,
        },
        components: {
          Menu: {
            itemHeight: 40,
            itemSelectedBg: '#eaf3ff',
            itemMarginInline: 12,
            subMenuItemBg: '#fff',
          },
          Table: {
            headerBg: '#f8fafc',
            headerColor: '#64748b',
            cellPaddingBlock: 15,
          },
          Card: { headerHeight: 58 },
          Button: { primaryShadow: '0 3px 7px rgba(22,119,255,.12)' },
        },
      }}
    >
      <App>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <Application />
          </BrowserRouter>
        </QueryClientProvider>
      </App>
    </ConfigProvider>
  </React.StrictMode>,
);
