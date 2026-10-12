# 图片与视频详情生产发布

发布时间：2026-10-10 11:34（Asia/Shanghai）。入口：http://192.168.1.34:18088 。

版本：`atlas-knowledge:media-preview-20261010-113456`；镜像：`sha256:1c0cbb0881e3195a609fb4608bb8cf199f36b06890f6bc980c27a7f2d13f3e68`。

图片和视频详情统一使用平台蓝色，预览区域透明、浅色半透明磨砂遮罩；视频增加详情入口、播放与下载。保留图片缩放、原始尺寸及适应窗口功能，支持手机。

本次基于当前线上应用镜像只替换前端资源，并同步三个前端源码文件与创作台测试。API、Worker 均运行新版镜像，API 健康检查通过，重启次数均为 0；环境文件校验和、基础设施数据卷挂载保持一致。

备份：`/work/project/atlas-knowledge/backups/media-preview-20261010-113456`，包含数据库快照、前端源码/资源和环境配置，权限 600。发布包：`/work/project/atlas-knowledge/releases/media-preview-20261010-113456`。

生产入口运行 `frontend/e2e/studio.spec.ts`，3 项测试通过，覆盖图片缩放、视频详情播放与下载、关闭、手机布局、宽屏布局及成员权限。测试中的模型、生成任务和身份均使用浏览器 fixture。另以真实管理员验证登录、创作台和退出，核对线上入口、样式与创作台脚本字节与本地构建完全一致，无浏览器脚本错误；见 `media-preview-server-verification.json`。

回滚应用与前端源码（保留发布后业务数据）：

```bash
cd /work/project/atlas-knowledge
docker tag atlas-knowledge:before-media-preview-20261010-113456 atlas-knowledge:local
tar -xzf backups/media-preview-20261010-113456/frontend-and-config.tar.gz -C . frontend
docker compose -p atlas-knowledge up -d --no-deps --no-build --wait --wait-timeout 180 api
docker compose -p atlas-knowledge up -d --no-deps --no-build worker
```
