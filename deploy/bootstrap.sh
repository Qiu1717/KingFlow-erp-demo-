#!/usr/bin/env bash
# KingFlow ERP 一键部署（方案 C：明文 HTTP，80 端口直连 IP）
# 用法（服务器上，root）：bash bootstrap.sh /root/kingflow-src.tar.gz
# 幂等：可重复执行；已安装的组件会跳过或覆盖配置。
set -euo pipefail

TARBALL="${1:-/root/kingflow-src.tar.gz}"
PUBLIC_IP="49.233.200.176"
APP_ROOT=/opt/kingflow
APP_USER=kingflow
DATA_DIR=/var/lib/kingflow
ENV_DIR=/etc/kingflow
ENV_FILE=$ENV_DIR/erp.env
NODE_HOME=/opt/nodejs
STAMP="$(date +%Y%m%d-%H%M%S)"
RELEASE="$APP_ROOT/releases/$STAMP"

log() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }
die() { printf '\033[1;31m失败：%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行"
[ -f "$TARBALL" ] || die "找不到源码包 $TARBALL"

log "0/9 系统信息"
. /etc/os-release
echo "$PRETTY_NAME / $(nproc) 核 / $(free -m | awk '/^Mem:/{print $2}') MB"

log "1/9 安装基础依赖（nginx / xz / openssl）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx xz-utils openssl ca-certificates >/dev/null
nginx -v 2>&1

log "2/9 安装 Node.js 24"
if [ -x "$NODE_HOME/bin/node" ] && "$NODE_HOME/bin/node" -e 'process.exit(process.versions.node.split(".")[0]>=24?0:1)' 2>/dev/null; then
  echo "已存在 $("$NODE_HOME/bin/node" -v)，跳过"
else
  VER="$(curl -fsSL --max-time 20 https://registry.npmmirror.com/-/binary/node/index.json 2>/dev/null | grep -o '"version":"v24\.[^"]*"' | head -1 | cut -d'"' -f4 || true)"
  [ -n "${VER:-}" ] || VER="$(curl -fsSL --max-time 20 https://nodejs.org/dist/index.json | grep -o '"version":"v24\.[^"]*"' | head -1 | cut -d'"' -f4)"
  [ -n "$VER" ] || die "无法获取 Node 24 版本号"
  echo "目标版本 $VER"
  PKG="node-$VER-linux-x64.tar.xz"
  TMP="$(mktemp -d)"
  for BASE in "https://registry.npmmirror.com/-/binary/node/$VER" "https://nodejs.org/dist/$VER"; do
    if curl -fSL --max-time 300 "$BASE/$PKG" -o "$TMP/node.tar.xz"; then echo "已从 $BASE 下载"; break; fi
  done
  [ -s "$TMP/node.tar.xz" ] || die "Node 下载失败"
  rm -rf "$NODE_HOME"
  mkdir -p "$NODE_HOME"
  tar -xJf "$TMP/node.tar.xz" -C "$NODE_HOME" --strip-components=1
  rm -rf "$TMP"
  ln -sfn "$NODE_HOME/bin/node" /usr/local/bin/node
  ln -sfn "$NODE_HOME/bin/npm" /usr/local/bin/npm
  ln -sfn "$NODE_HOME/bin/npx" /usr/local/bin/npx
  echo "已安装 $("$NODE_HOME/bin/node" -v)"
fi
NODE_BIN="$NODE_HOME/bin/node"

log "3/9 安装 pnpm 11.25.0"
export PATH="$NODE_HOME/bin:$PATH"
if ! (command -v pnpm >/dev/null 2>&1 && pnpm --version | grep -q '^11\.'); then
  npm config set registry https://registry.npmmirror.com >/dev/null
  npm install -g pnpm@11.25.0 >/dev/null 2>&1 || die "pnpm 安装失败"
  ln -sfn "$NODE_HOME/bin/pnpm" /usr/local/bin/pnpm
fi
echo "pnpm $(pnpm --version)"

log "4/9 运行用户、目录与交换分区"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_ROOT" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$APP_ROOT"
install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$APP_ROOT/releases"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$DATA_DIR"
install -d -o kingflow -g kingflow -m 0750 /var/backups/kingflow
install -d -o root -g "$APP_USER" -m 0750 "$ENV_DIR"
# 判据是「系统当前有没有任何 swap」，而不是「有没有 /swapfile」：
# Ubuntu 22.04+ 镜像自带 /swap.img，按文件名判断会重复创建、白占 2G 磁盘。
if [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "已启用 2G swap"
else
  echo "swap 已存在：$(swapon --show --noheadings | awk '{print $1}' | tr '\n' ' ')"
fi

log "5/9 解包源码到 $RELEASE"
mkdir -p "$RELEASE"
tar -xzf "$TARBALL" -C "$RELEASE"
[ -f "$RELEASE/pnpm-workspace.yaml" ] || die "源码包结构不对，缺少 pnpm-workspace.yaml"
cat > "$APP_ROOT/.npmrc" <<'EOF'
registry=https://registry.npmmirror.com
EOF
chown -R "$APP_USER:$APP_USER" "$RELEASE" "$APP_ROOT/.npmrc"
ln -sfn "$RELEASE" "$APP_ROOT/current"
echo "已切换 current -> $RELEASE"

log "6/9 安装依赖并构建（2G 机器约 5–10 分钟）"
sudo -u "$APP_USER" -H env HOME="$APP_ROOT" PATH="$NODE_HOME/bin:$PATH" bash -c "
  set -e
  cd '$APP_ROOT/current'
  pnpm install --frozen-lockfile
  pnpm build
"
[ -f "$APP_ROOT/current/apps/web/dist/index.html" ] || die "前端构建产物缺失"
[ -f "$APP_ROOT/current/apps/api/dist/apps/api/src/server.js" ] || die "后端构建产物缺失"
echo "构建产物完整"

log "7/9 生成环境变量与演示账号"
if [ -f "$ENV_FILE" ]; then
  echo "复用已有 $ENV_FILE"
else
  ADMIN_PWD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16)"
  DEMO_PWD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16)"
  cat > "$ENV_FILE" <<EOF
NODE_ENV=development
APP_ORIGIN=http://$PUBLIC_IP
DATABASE_URL=file:$DATA_DIR/erp.db
HOST=127.0.0.1
PORT=3001
TRUST_PROXY=loopback
EOF
  chown root:"$APP_USER" "$ENV_FILE" && chmod 0640 "$ENV_FILE"
  cat > /root/kingflow-credentials.txt <<EOF
KingFlow ERP 演示账号（$(date '+%F %T')）
地址: http://$PUBLIC_IP
admin / $ADMIN_PWD     （系统管理员，全部权限）
demo  / $DEMO_PWD      （访客，只读）
EOF
  chmod 0600 /root/kingflow-credentials.txt
  echo "已生成账号，密码保存在 /root/kingflow-credentials.txt"
fi

set -a; . "$ENV_FILE"; set +a
sudo -u "$APP_USER" -H env HOME="$APP_ROOT" PATH="$NODE_HOME/bin:$PATH" \
  NODE_ENV="$NODE_ENV" APP_ORIGIN="$APP_ORIGIN" DATABASE_URL="$DATABASE_URL" \
  bash -c "cd '$APP_ROOT/current' && pnpm --filter @kingflow/api db:migrate"

if [ -f /root/kingflow-credentials.txt ]; then
  ADMIN_PWD="$(awk '/^admin/{print $3}' /root/kingflow-credentials.txt)"
  DEMO_PWD="$(awk '/^demo/{print $3}' /root/kingflow-credentials.txt)"
  sudo -u "$APP_USER" -H env HOME="$APP_ROOT" PATH="$NODE_HOME/bin:$PATH" \
    NODE_ENV=development DATABASE_URL="$DATABASE_URL" \
    ADMIN_PASSWORD="$ADMIN_PWD" DEMO_PASSWORD="$DEMO_PWD" \
    bash -c "cd '$APP_ROOT/current' && pnpm --filter @kingflow/api exec tsx scripts/provision-demo.ts"
fi

log "8/9 安装 systemd 服务与 Nginx 站点"
cat > /etc/systemd/system/kingflow-erp.service <<EOF
[Unit]
Description=KingFlow ERP (API + Web)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_ROOT/current/apps/api
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN dist/apps/api/src/server.js
Restart=always
RestartSec=3
TimeoutStopSec=20

StateDirectory=kingflow
StateDirectoryMode=0750
UMask=0077

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=$DATA_DIR
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/nginx/conf.d/kingflow-erp.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name _;

    root $APP_ROOT/current/apps/web/dist;
    index index.html;

    client_max_body_size 2m;
    access_log /var/log/nginx/kingflow.access.log;
    error_log  /var/log/nginx/kingflow.error.log warn;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host              \$http_host;
        proxy_set_header X-Forwarded-Proto http;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_read_timeout 30s;
        add_header Cache-Control "no-store" always;
    }

    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
        add_header Cache-Control "no-store";
    }
}
EOF
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx 2>/dev/null || systemctl restart nginx

systemctl daemon-reload
systemctl enable kingflow-erp >/dev/null 2>&1 || true
systemctl restart kingflow-erp
for i in $(seq 1 20); do sleep 1; systemctl is-active --quiet kingflow-erp && break; done
systemctl is-active --quiet kingflow-erp || { journalctl -u kingflow-erp -n 40 --no-pager; die "服务未启动"; }

log "9/9 每日备份定时器与自检"
cat > /usr/local/bin/kingflow-backup <<'EOF'
#!/bin/sh
set -eu
DEST=/var/backups/kingflow
mkdir -p "$DEST"
cd /opt/kingflow/current
export PATH=/opt/nodejs/bin:$PATH HOME=/opt/kingflow
# db:backup 拒绝覆盖已存在文件；同一天重跑（失败重试/手工补跑）时退回带时分的目标名。
TARGET="$DEST/erp-$(date +%Y%m%d).db"
if [ -e "$TARGET" ]; then TARGET="$DEST/erp-$(date +%Y%m%d-%H%M).db"; fi
pnpm db:backup "$TARGET"
find "$DEST" -name 'erp-*.db' -mtime +14 -delete
EOF
chmod 750 /usr/local/bin/kingflow-backup
chown kingflow:kingflow /usr/local/bin/kingflow-backup

cat > /etc/systemd/system/kingflow-backup.service <<'EOF'
[Unit]
Description=KingFlow daily SQLite backup
[Service]
Type=oneshot
User=kingflow
Group=kingflow
EnvironmentFile=/etc/kingflow/erp.env
ExecStart=/usr/local/bin/kingflow-backup
EOF
cat > /etc/systemd/system/kingflow-backup.timer <<'EOF'
[Unit]
Description=KingFlow daily backup timer
[Timer]
OnCalendar=*-*-* 04:10:00
Persistent=true
RandomizedDelaySec=5m
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now kingflow-backup.timer >/dev/null 2>&1

echo "--- 进程与监听 ---"
systemctl is-active kingflow-erp
ss -lntp | grep -E ':80 |:3001' || true
echo "--- 探针 ---"
echo "health: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/api/v1/health)"
echo "ready : $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/api/v1/ready)"
echo "首页   : $(curl -s -o /dev/null -w '%{http_code} %{content_type}' http://127.0.0.1/)"
echo "深链接 : $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/purchases)"
echo "--- 账号 ---"
[ -f /root/kingflow-credentials.txt ] && cat /root/kingflow-credentials.txt || echo "沿用已有账号"
log "部署完成"
