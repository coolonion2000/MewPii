# MewPii — Docker 发布步骤

发布 `mewpii` 到 Docker Hub（`coolonion2000/mewpii`，linux/amd64）。照这个顺序做即可，全部命令在仓库根目录 `/Users/cosmo010225/Pii` 执行。

## 0. 前置条件

- Docker Desktop 正在运行：`open -a Docker`，等 `docker info` 能返回
- 有 Docker Hub 账号 `coolonion2000` + **Personal Access Token（PAT）**
  - 通过环境变量 `DOCKERHUB_PAT` 临时注入，禁止写入仓库、命令脚本或聊天产物
  - 获取：https://hub.docker.com/settings/security → New Access Token（勾 `Read, Write`）
- 仓库代码是最新且已推送

## 1. 推送代码（确保构建用最新）

```bash
cd /Users/cosmo010225/Pii
git branch --show-current       # 必须是 main
git status --short             # 必须无输出；有改动就停止，不要自动 git add/commit
git push origin main
git log --oneline | head -3    # 确认推送成功
```

> ⚠️ **必须**先确认工作区干净并成功 `git push`，禁止发布流程自动提交其他开发中的改动。

## 2. 确定下一个版本号

看 Docker Hub 现有 tags，取下一个数字。当前 `latest` 是 `0.1.10`，所以下一个是 **`0.1.11`**（若用户指定更高版本则照用）。

```bash
curl -s "https://hub.docker.com/v2/repositories/coolonion2000/mewpii/tags" | python3 -c "import json,sys;print(sorted(t['name'] for t in json.load(sys.stdin).get('results',[])))"
```

## 3. 登录 Docker Hub

```bash
read -s DOCKERHUB_PAT && export DOCKERHUB_PAT
echo "$DOCKERHUB_PAT" | docker login -u coolonion2000 --password-stdin
```

## 4. 构建并推送（amd64）

```bash
cd /Users/cosmo010225/Pii
docker buildx build --platform linux/amd64 -t coolonion2000/mewpii:<版本号> -t coolonion2000/mewpii:latest --push .
```

> 若报 `Cannot connect to the Docker daemon` → 等 Docker Desktop 完全启动（`docker info` 通过）再跑。
> 若 `npm ci` 报 `EUSAGE / out of sync` → 说明 `package-lock.json` 不同步，先 `npm install` 再重试。
> 若网络抖动中途失败 → 重试同一条命令（buildx 有缓存，重试快）。
> `--platform linux/amd64` 不能去掉（Mac 是 arm64，NAS 是 amd64）。

## 5. 验证推送成功

```bash
curl -s "https://hub.docker.com/v2/repositories/coolonion2000/mewpii/tags" | python3 -c "import json,sys;print(sorted(t['name'] for t in json.load(sys.stdin).get('results',[])))"
# 应看到 <版本号> 和 latest；且 latest 已指向新版本
```

若看到 `<版本号>` 已在列表 → 发布成功。

## 6. NAS（绿联 UGOS）更新

- Docker 应用 → 镜像 → 拉取 `docker.io/coolonion2000/mewpii:<版本号>`（或 `latest`）
- 停止旧容器 → 用新镜像重建（环境变量 `PII_PASSWORD`、两个卷映射 `/docker/pii:/root/.pi`、`/docker/code:/code` 不变）
- 启动后浏览器打开，确认左下角版本角标更新（`v<版本号>`）

## 常见报错速查

| 报错 | 处理 |
|---|---|
| `Cannot connect to the Docker daemon` | `open -a Docker`，等 `docker info` 通过 |
| `npm ci ... out of sync` | `npm install` 后再构建 |
| `permission_denied ... expected scopes` | PAT 没勾 Write，重新建 PAT |
| arm64/amd64 混用 | 必须 `--platform linux/amd64` |
