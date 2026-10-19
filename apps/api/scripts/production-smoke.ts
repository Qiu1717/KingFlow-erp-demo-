import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 生产 HTTPS 冒烟：真实反向代理 + 生产构建 + 真实数据库。
 *
 * 在本机用自签证书起一个 HTTPS 终止代理（等价 nginx 角色），转发到以 production
 * 模式运行、由 `pnpm build` 产出的编译产物，验证：
 * 生产强制 HTTPS、Secure/HttpOnly Cookie、静态资源与 SPA 回退、API 不可缓存、
 * 健康/就绪探针、来源校验、明文直连拒绝，以及登录→业务查询→退出的完整链路。
 *
 * 前置：`pnpm build`（需要 apps/web/dist 与 apps/api/dist）。
 * 用法：node --import tsx scripts/production-smoke.ts
 */

const apiRoot = resolve(import.meta.dirname, '..');
const root = resolve(apiRoot, '../..');
// 工作区内的临时目录：部分 Windows 环境的系统 TEMP 是只读的（受管策略/杀毒软件），
// 冒烟用的独立库放在工作区内既避开权限问题，也不会污染任何真实数据库。
const work = mkdtempSync(join(apiRoot, '.smoke-'));
const apiPort = 3101;
const httpsPort = 8443;
const dbFile = join(work, 'smoke.db').replaceAll('\\', '/');
const failures: string[] = [];
const children: ChildProcess[] = [];

const pass = (name: string) => console.log(`  \u2713 ${name}`);
const fail = (name: string, detail = '') => {
  console.log(`  \u2717 ${name} ${detail}`);
  failures.push(name);
};
const check = (name: string, ok: boolean, detail = '') =>
  ok ? pass(name) : fail(name, detail);
const section = (title: string) => console.log(`${title}`);

function selfSignedCertificate() {
  const certPath = join(work, 'cert.pem');
  const keyPath = join(work, 'key.pem');
  const candidates = [
    'openssl',
    'E:\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(
        candidate,
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
          '-keyout', keyPath, '-out', certPath,
          '-days', '1', '-subj', '/CN=localhost',
        ],
        { stdio: 'ignore' },
      );
      if (existsSync(certPath) && existsSync(keyPath))
        return {
          key: readFileSync(keyPath),
          cert: readFileSync(certPath),
        };
    } catch {
      // 尝试下一个候选，全部失败时给出明确错误。
    }
  }
  throw new Error('未找到 openssl，无法生成本机自签证书（可安装 Git for Windows）');
}

/** 直接发起 HTTPS 请求（自签证书校验关闭，仅本机冒烟）。 */
async function call(
  base: string,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  const url = new URL(base + path);
  const secure = url.protocol === 'https:';
  const module = secure ? await import('node:https') : await import('node:http');
  return new Promise((resolvePromise, rejectPromise) => {
    const req = (module.request as unknown as typeof httpRequest)(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: init.method ?? 'GET',
        headers: init.headers,
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, unknown>,
            body,
          }),
        );
      },
    );
    req.on('error', rejectPromise);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/** 轮询直到健康检查真正返回 200；502 等代理错误不算就绪。 */
const waitFor = async (base: string, attempts = 60) => {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await call(base, '/api/v1/health');
      if (response.status === 200) return;
    } catch {
      // 代理尚未监听或上游未起，继续重试。
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`服务未在预期时间内就绪：${base}`);
};

const cookieHeader = (headers: Record<string, unknown>) => {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return { all: list.join(';'), pair: (list[0] ?? '').split(';')[0] };
};

async function main() {
  if (!existsSync(join(root, 'apps/web/dist/index.html')))
    throw new Error('缺少前端生产构建，请先执行 pnpm build');
  if (!existsSync(join(apiRoot, 'dist/apps/api/src/server.js')))
    throw new Error('缺少 API 生产构建，请先执行 pnpm build');

  console.log(`工作目录：${work}`);
  const tls = selfSignedCertificate();

  // 1. 迁移 + Seed 到独立冒烟库（绝不复用 dev.db）。
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: `file:${dbFile}`,
    DEMO_PASSWORD: 'KingFlow@2026',
  };
  execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/migrate.ts'],
    { cwd: apiRoot, env, stdio: 'ignore' },
  );
  execFileSync(process.execPath, ['--import', 'tsx', 'prisma/seed.ts'], {
    cwd: apiRoot,
    env,
    stdio: 'ignore',
  });

  // 2. 以生产模式启动编译产物（纯 node，不经 tsx）。
  const api = spawn(process.execPath, ['dist/apps/api/src/server.js'], {
    cwd: apiRoot,
    env: {
      ...env,
      NODE_ENV: 'production',
      APP_ORIGIN: `https://localhost:${httpsPort}`,
      DATABASE_URL: `file:${dbFile}`,
      HOST: '127.0.0.1',
      PORT: String(apiPort),
      TRUST_PROXY: 'loopback',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(api);
  api.stderr?.on('data', (chunk) => process.stderr.write(`[api] ${chunk}`));
  api.stdout?.on('data', (chunk) => process.stdout.write(`[api] ${chunk}`));
  // 子进程若因配置或构建问题直接退出，要立即暴露真实原因而不是只看到 502。
  let exitReason = '';
  api.once('exit', (code, signal) => {
    exitReason = `API 进程退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`;
  });

  // 3. HTTPS 终止代理（等价 nginx 角色），注入可信转发头。
  const proxy = createHttpsServer(tls, (req, res) => {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: apiPort,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '203.0.113.7',
        },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end('bad gateway'));
    req.pipe(upstream);
  });
  await new Promise<void>((resolvePromise) =>
    proxy.listen(httpsPort, '127.0.0.1', () => resolvePromise()),
  );

  const base = `https://localhost:${httpsPort}`;
  try {
    try {
      await waitFor(base);
    } catch (error) {
      throw new Error(
        `${(error as Error).message}${exitReason ? `（${exitReason}）` : ''}`,
        { cause: error },
      );
    }

    section('健康与就绪：');
    check('健康检查 200', (await call(base, '/api/v1/health')).status === 200);
    check('就绪检查 200', (await call(base, '/api/v1/ready')).status === 200);

    section('静态资源与 SPA：');
    const index = await call(base, '/');
    check('首页 200', index.status === 200);
    check('首页返回应用外壳', index.body.includes('<div id="root"'));
    check(
      '首页不可缓存',
      String(index.headers['cache-control'] ?? '').includes('no-store'),
    );
    check('SPA 深链回退 200', (await call(base, '/sales-orders')).status === 200);
    const unknownApi = await call(base, '/api/v1/definitely-missing');
    check(
      '未知API返回JSON而非HTML',
      String(unknownApi.headers['content-type'] ?? '').includes('json'),
    );

    section('认证与 Cookie 安全：');
    check('未登录 401', (await call(base, '/api/v1/auth/me')).status === 401);
    const login = await call(base, '/api/v1/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'KingFlow@2026' }),
    });
    check('HTTPS 登录成功', login.status === 200, login.body.slice(0, 120));
    const cookies = cookieHeader(login.headers);
    check('Session Cookie 为 Secure', /secure/i.test(cookies.all));
    check('Session Cookie 为 HttpOnly', /httponly/i.test(cookies.all));
    const csrf = (JSON.parse(login.body) as { data?: { csrfToken?: string } })
      .data?.csrfToken;
    check('返回合法 CSRF Token', /^[a-f0-9]{64}$/.test(csrf ?? ''));

    section('真实业务查询：');
    for (const path of [
      '/api/v1/products?pageSize=5',
      '/api/v1/sales-orders?pageSize=5',
      '/api/v1/receivables?pageSize=5',
      '/api/v1/reports/sales',
    ]) {
      const response = await call(base, path, {
        headers: { Cookie: cookies.pair },
      });
      check(`GET ${path} 200`, response.status === 200, `实际 ${response.status}`);
      check(
        `GET ${path} 不可缓存`,
        String(response.headers['cache-control'] ?? '').includes('no-store'),
      );
    }

    section('来源校验与明文拒绝：');
    const forged = await call(base, '/api/v1/products', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf ?? '',
        Cookie: cookies.pair,
      },
      body: '{}',
    });
    check('伪造来源被拒 403', forged.status === 403, `实际 ${forged.status}`);
    const plainBusiness = await call(
      `http://127.0.0.1:${apiPort}`,
      '/api/v1/products',
    );
    check(
      '明文直连业务接口被拒 426',
      plainBusiness.status === 426,
      `实际 ${plainBusiness.status}`,
    );
    const plainHealth = await call(
      `http://127.0.0.1:${apiPort}`,
      '/api/v1/health',
    );
    check('明文直连健康探针可用', plainHealth.status === 200);

    section('退出：');
    const logout = await call(base, '/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf ?? '',
        Cookie: cookies.pair,
      },
      body: '{}',
    });
    check('退出 200', logout.status === 200, `实际 ${logout.status}`);
    const after = await call(base, '/api/v1/auth/me', {
      headers: { Cookie: cookies.pair },
    });
    check('退出后旧会话失效 401', after.status === 401);
  } finally {
    await new Promise<void>((resolvePromise) => proxy.close(() => resolvePromise()));
    for (const child of children) child.kill();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }

  if (failures.length > 0) {
    console.error(`\n失败 ${failures.length} 项：${failures.join('、')}`);
    console.error(`日志保留在 ${work}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n生产 HTTPS 冒烟全部通过。');
  rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  console.error(`工作目录保留在 ${work}`);
  process.exitCode = 1;
});
