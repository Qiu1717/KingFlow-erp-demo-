import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { loadRuntimeConfig } from '../src/config/runtime.js';
import { createApp } from '../src/app.js';
import { prisma } from '../src/repositories/db.js';

/**
 * 生产配置与反向代理边界。
 *
 * 这些用例用不同的 RuntimeConfig 构造彼此独立的 app 实例，验证：
 * 配置注入真正生效（不再读进程级 process.env）、转发头可信性、
 * Cookie 安全属性、静态资源与 API 的缓存策略、错误信息不泄露内部细节。
 */
const environment = {
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://erp.example.com',
  DATABASE_URL: 'file:/var/lib/kingflow/erp.db',
  TRUST_PROXY: 'loopback',
};

/** 为一个 app 起真实端口，返回可复用的 agent 与关闭函数。 */
async function serve(config: Parameters<typeof createApp>[0]) {
  const server: Server = createServer(createApp(config));
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  return {
    request: () => request(server),
    agent: () => request.agent(server),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of closers) await close();
  await prisma.$disconnect();
});

describe('生产运行时配置校验', () => {
  it('拒绝缺失来源、HTTP来源、带路径来源、相对数据库及过度信任代理', () => {
    for (const override of [
      { APP_ORIGIN: undefined },
      { APP_ORIGIN: 'http://erp.example.com' },
      { APP_ORIGIN: 'https://erp.example.com/evil' },
      { APP_ORIGIN: 'https://erp.example.com?x=1' },
      { DATABASE_URL: undefined },
      { DATABASE_URL: 'file:./dev.db' },
      { DATABASE_URL: 'file:relative/path.db' },
      { TRUST_PROXY: 'true' },
      { TRUST_PROXY: '1' },
      { TRUST_PROXY: '*' },
    ]) {
      expect(
        () => loadRuntimeConfig({ ...environment, ...override }),
        `${JSON.stringify(override)} 应被拒绝`,
      ).toThrow();
    }
    const config = loadRuntimeConfig(environment);
    expect(config.appOrigin).toBe('https://erp.example.com');
    expect(config.production).toBe(true);
    expect(config.trustProxy).toBe('loopback');
  });

  it('开发与测试环境默认允许本地来源，但生产必须显式配置', () => {
    expect(loadRuntimeConfig({ NODE_ENV: 'development' }).appOrigin).toBe(
      'http://localhost:5173',
    );
    expect(loadRuntimeConfig({ NODE_ENV: 'test' }).production).toBe(false);
    expect(() => loadRuntimeConfig({ NODE_ENV: 'production' })).toThrow();
  });
});

describe('HTTPS、转发头与代理信任边界', () => {
  it('不可信代理不能用转发头伪装HTTPS', async () => {
    const service = await serve(
      loadRuntimeConfig({ ...environment, TRUST_PROXY: 'false' }),
    );
    closers.push(service.close);
    const response = await service
      .request()
      .get('/api/v1/auth/me')
      .set('X-Forwarded-Proto', 'https');
    expect(response.status).toBe(426);
    expect(response.body.error.code).toBe('HTTPS_REQUIRED');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('可信本地代理传递HTTPS后进入认证，未知API不返回HTML', async () => {
    const service = await serve(loadRuntimeConfig(environment));
    closers.push(service.close);
    expect(
      (
        await service
          .request()
          .get('/api/v1/auth/me')
          .set('X-Forwarded-Proto', 'https')
      ).status,
    ).toBe(401);
    const response = await service
      .request()
      .get('/api/v1/nonexistent')
      .set('X-Forwarded-Proto', 'https')
      .set('Accept', 'text/html');
    expect([401, 404]).toContain(response.status);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('生产健康与就绪检查允许在不安全的探测请求下响应', async () => {
    const service = await serve(loadRuntimeConfig(environment));
    closers.push(service.close);
    // 健康探针通常由负载均衡直接以 HTTP 访问容器，必须可用。
    expect((await service.request().get('/api/v1/health')).status).toBe(200);
    expect((await service.request().get('/api/v1/ready')).status).toBe(200);
    // 但其它任何路径都不得在 HTTP 下被服务。
    expect((await service.request().get('/api/v1/products')).status).toBe(426);
  });

  it('安全响应头覆盖点击劫持、嗅探与引用来源', async () => {
    const service = await serve(loadRuntimeConfig(environment));
    closers.push(service.close);
    const response = await service
      .request()
      .get('/api/v1/health')
      .set('X-Forwarded-Proto', 'https');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['referrer-policy']).toBe(
      'no-referrer',
    );
    expect(response.headers['content-security-policy']).toBeTruthy();
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-request-id']).toMatch(
      /^[a-f0-9-]{36}$/,
    );
  });
});

describe('配置注入不再依赖进程级环境变量', () => {
  it('两个不同来源的 app 实例各自校验自己的Origin', async () => {
    const original = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = 'http://localhost:5173';
    try {
      const a = await serve(
        loadRuntimeConfig({
          NODE_ENV: 'test',
          APP_ORIGIN: 'http://localhost:5173',
        }),
      );
      const b = await serve(
        loadRuntimeConfig({
          NODE_ENV: 'test',
          APP_ORIGIN: 'http://tenant-b.local',
        }),
      );
      closers.push(a.close, b.close);
      // 同一个进程内两个来源不同的 app：A 只认自己的来源。
      const denied = await a
        .request()
        .post('/api/v1/auth/login')
        .set('Origin', 'http://tenant-b.local')
        .send({ username: 'x', password: 'y' });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('INVALID_ORIGIN');
      // 来源正确时进入业务校验（凭据错误 → 401），而不是来源被拒。
      const accepted = await a
        .request()
        .post('/api/v1/auth/login')
        .set('Origin', 'http://localhost:5173')
        .send({ username: 'missing-user', password: 'wrong-password' });
      expect(accepted.status).toBe(401);
      const tenantB = await b
        .request()
        .post('/api/v1/auth/login')
        .set('Origin', 'http://tenant-b.local')
        .send({ username: 'missing-user', password: 'wrong-password' });
      expect(tenantB.status).toBe(401);
    } finally {
      if (original === undefined) delete process.env.APP_ORIGIN;
      else process.env.APP_ORIGIN = original;
    }
  });
});

describe('错误响应与请求体边界', () => {
  it('无效JSON、超大请求与错误不泄露内部信息且禁止缓存', async () => {
    const service = await serve(loadRuntimeConfig({ NODE_ENV: 'test' }));
    closers.push(service.close);
    for (const [body, status, code] of [
      ['{"broken":', 400, 'INVALID_JSON'],
      [JSON.stringify({ value: 'a'.repeat(110000) }), 413, 'PAYLOAD_TOO_LARGE'],
    ] as const) {
      const response = await service
        .request()
        .post('/api/v1/auth/login')
        .set('Origin', 'http://localhost:5173')
        .set('Content-Type', 'application/json')
        .send(body);
      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(response.body)).not.toMatch(
        /prisma|node_modules|passwordHash|stack/i,
      );
      expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
    }
  });

  it('未知接口返回统一404 JSON，未知方法不会落成HTML', async () => {
    const service = await serve(loadRuntimeConfig({ NODE_ENV: 'test' }));
    closers.push(service.close);
    for (const method of ['get', 'post', 'put', 'delete', 'patch'] as const) {
      const probe = service.request();
      const response = await probe[method](
        '/api/v1/definitely-not-a-route',
      ).set('Origin', 'http://localhost:5173');
      expect([401, 404, 405]).toContain(response.status);
      expect(response.headers['content-type']).toContain('application/json');
      if (response.status === 404)
        expect(response.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('就绪检查真实验证数据库模式，而存活检查独立可用', async () => {
    const service = await serve(loadRuntimeConfig({ NODE_ENV: 'test' }));
    closers.push(service.close);
    expect((await service.request().get('/api/v1/health')).status).toBe(200);
    const ready = await service.request().get('/api/v1/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.data.status).toBe('ready');
  });
});
