# 交付就绪评估（2026-10-19）

本文件记录「能否交付」的判断依据：实际执行过的命令、真实失败、修复方式、以及明确的环境边界。结论以本文和 `VERIFICATION.md` 为准，不以计划或意图为准。

## 结论

| 维度 | 状态 | 依据 |
|---|---|---|
| 业务闭环 | 通过 | 采购→入库→应付→付款、销售→出库→应收→收款全链路真实数据库与真实浏览器验证 |
| 并发一致性 | 通过 | 20 路并发写入/抢库存/抢余额，账实一致，无超发、无负库存、无重复过账 |
| 事务与幂等 | 通过 | 多行中途失败全回滚；同键重放返回同一单据；同键异内容/跨业务/跨用户复用键 409 |
| 备份与恢复 | 通过 | `VACUUM INTO` 一致性快照、恢复到新库、七项账实不变量核对、恢复演练 |
| 生产运行 | 通过 | 真实 HTTPS 终止代理 + 编译产物 + Secure/HttpOnly Cookie + SPA 回退 + 探针 |
| 安全 | 通过 | 密码哈希、HttpOnly Session、CSRF、来源校验、限流、六角色权限矩阵、审计脱敏 |
| 自动化回归 | 通过 | 见下方实际结果 |
| 公网真实部署 | **未验证** | 本轮未申请域名/证书/云主机，不做未授权发布 |

## 本轮修复的真实缺陷

按「先复现、后修复」顺序记录，每项都有对应的自动化用例。

1. **SQLite 并发写入偶发 503（P1008 socket timeout）**
   - 现象：20 路并发过账约一半失败，`enterprise.test.ts` 4 项红，单次运行 25 秒。
   - 根因：Prisma 默认按 CPU 数打开多个 SQLite 连接，多连接抢写锁互相等待直至驱动层超时。**不是业务规则错误，是连接池与存储引擎模型不匹配。**
   - 修复：`apps/api/src/repositories/db.ts` 固定 `connection_limit=1&socket_timeout=30`，写入在客户端串行化；对交互式事务加指数退避重试（P1008/P2028/P2034/P2024，最多 5 次带抖动）。
   - 结果：20/20 成功且账实一致；`enterprise.test.ts` 从 25 秒 4 失败 → 0.8 秒全绿。**没有通过降低并发数或弱化断言来规避。**

2. **`pnpm build` 产出的后端无法运行**
   - 现象：`node apps/api/dist/apps/api/src/server.js` 报 `ERR_MODULE_NOT_FOUND`，找不到 `packages/shared/src/purchase.js`。
   - 根因：`@kingflow/shared` 的 `exports` 指向 `.ts` 源码（开发/测试由 tsx 执行），编译产物保留了包名说明符，纯 Node 无法加载 TypeScript。
   - 修复：新增 `apps/api/scripts/postbuild.ts`，在 tsc 之后把产物中的共享包引用改写为指向同一份编译输出的相对路径，使 dist 自包含；新增 `start:prod` 用纯 Node 启动。开发与测试工作流不变，不新增依赖。

3. **生产模式下前端静态目录解析错误**
   - 现象：编译产物启动即抛「缺少前端生产构建」，即使 `apps/web/dist` 存在。
   - 根因：`webDist` 用固定的 `../../../web/dist` 相对路径，在源码层级正确、在编译产物层级（`dist/apps/api/src/config/`）指向不存在的目录。
   - 修复：从模块目录逐级向上寻找含 `pnpm-workspace.yaml` 的工作区根，再取 `apps/web/dist`，两种上下文都正确。

4. **旧会话迟到的 401 会把新账号踢下线**
   - 现象：浏览器用例「旧会话业务请求延迟返回 401 时不能退出新账号」稳定失败。
   - 根因：全局响应拦截器把所有 401 都当作「当前会话失效」，切换账号前发出的请求迟到返回时误伤新会话。
   - 修复：请求发出时记录当时的 CSRF Token（会话标识），响应到达时用 `isCurrentSessionFailure()` 判断 401 是否属于当前会话，只对当前会话的 401 清登录态。

5. **`createApp(config)` 注入的配置被忽略**
   - 现象：安全中间件与 Cookie 属性直接读 `process.env`，注入的 `RuntimeConfig` 不生效，多个不同配置的 app 实例互相污染。
   - 修复：配置挂到 `app.locals.runtime`，请求期经 `config/context.ts` 读取；Cookie 属性统一由 `sessionCookie()` 生成。新增用例用两个不同来源的 app 实例证明隔离生效。

6. **测试基础设施：supertest 共享 server 竞态**
   - 现象：`api.test.ts` 8 项报 `Cannot read properties of null (reading 'address')`。
   - 根因：supertest 7 为 Express app 惰性创建共享 server，并在最后一个在途请求结束时关闭；请求生命周期交错时另一个请求 dispatch 时 server 已关闭。
   - 修复：`apps/api/tests/server.ts` 的 `startTestServer()` 显式 `createServer` + `listen(0)`，生命周期由测试文件控制。**这是测试基础设施缺陷，改测试而不是改业务代码。**

7. **`recovery-service.ts` 缺失**
   - 现象：类型检查与测试均因缺少该模块失败（Codex 会话中断遗留）。
   - 修复：实现备份/恢复/七项账实核对/恢复演练，并提供运维 CLI。

## 实际执行的验证

以下命令与结果来自本轮真实执行，失败项已在上文说明修复过程。

| 命令 | 结果 |
|---|---|
| `pnpm lint` | 通过，0 错误 |
| `pnpm typecheck` | 根配置 / shared / API / Web 全部通过 |
| `pnpm test` | 18 个文件、**210/210** 通过（真实 SQLite 独立 test.db） |
| `pnpm test:e2e` | **45/45** 通过，约 4.9 分钟（真实浏览器 + 独立 e2e.db） |
| `pnpm build` | shared / API（含 postbuild）/ Web 全部通过 |
| `pnpm smoke:prod` | **27/27** 通过：真实 HTTPS 代理、Secure/HttpOnly Cookie、SPA 回退、探针、来源校验、明文拒绝、登录→查询→退出 |
| `pnpm db:verify` | 七项账实不变量全部通过 |
| `pnpm db:drill` | 备份→恢复→双库核对通过，生产库未被改动 |

### 排查过程中值得记录的失败与结论

以下都是本轮真实踩过并解决的坑：

- **构建产物无法运行**：`node dist/.../server.js` 报 `ERR_MODULE_NOT_FOUND`，根因是 `@kingflow/shared` 的 `exports` 指向 `.ts` 源码。用 postbuild 改写说明符后修复，并用 `start:prod` 实测可启动。
- **Windows 临时目录受限导致 esbuild 构建失败**：`remove ... Access is denied`。用 `scripts/with-local-temp.mjs` 把 TMP 重定向到工作区 `.tmp-build`；冒烟测试的独立库同样落在工作区内。
- **抽屉底部按钮被挤出视口**：实测按钮 `y=668~704` 而视口高 720，footer 未做 flex 约束。修正 CSS 后复测 footer `651~720`、按钮 `668~704`，完全可见。
- **一个 E2E 用例反复超时**：antd `message` 提示条的淡出动画让按钮位置持续变化，Playwright 的稳定性检查一直等待。改为按坐标点击（仍是真实鼠标事件）后通过。**这不是产品缺陷**——此前关于 loading 卡住、抽屉被销毁、网络未恢复的猜测都被逐条证伪后才定位到这里。

### 返工记录（如实保留）

- 六角色菜单用例最初把「分组可见性」和「子项权限」混写：财务人员持有 `receipts:read`/`shipments:read`，本应看到采购管理(采购入库)与销售管理(销售出库)，测试却断言整组隐藏。已改为按真实权限逐项推导。
- 多轮 E2E 失败源于测试定位方式（分页首屏、相同搜索词命中缓存、共享夹具状态、多 dialog 匹配），已逐条改为精确或自包含定位，**没有放宽任何业务断言**。

## 明确的环境边界（不得省略）

- 本轮验证在 Windows + Node.js 24 + 本机 Chrome 完成；未验证其他操作系统。
- SQLite 单实例部署，写入经客户端串行化。**这是单机交付规模的上限**：需要多实例/高并发写入时必须迁移 PostgreSQL 并重新验证事务与锁策略，不能直接套用当前结论。
- 报表面向 Demo 数据规模做内存聚合；大数据量需下推到数据库聚合与分页。
- 收付款只记录业务事实，不对接银行或支付机构；不提供总账、税务发票、多币种、退货、调拨、多租户、生产制造。
- 已过账单据不可修改或删除，也不提供红字冲销。
- 未申请域名、证书、云主机，未做公网发布；本地与受控环境验证不等于公网生产验收。
- 演示账号与演示密码仅用于本地/受控环境初始化，不得用于真实生产。
