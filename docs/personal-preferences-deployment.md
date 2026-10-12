# 创作自动入库开关生产发布

时间：2026-10-10 11:42（Asia/Shanghai）。入口：http://192.168.1.34:18088 。

版本：`atlas-knowledge:personal-preferences-20261010-114231`。镜像：`sha256:289f53a00ac7e069d31f4aa885be33ab5e2ea3740c2471539f9e72211c91eebe`。

个人中心「创作内容自动入库」改为标题右侧的品牌蓝色滑动开关，支持键盘和辅助技术。显示加载、保存和当前状态；加载失败可重新加载，保存失败保留原状态、显示错误并允许重试。等待 PUT 返回后更新开关状态，阻止保存中重复提交；工作空间刷新与保存分开处理，避免刷新失败误撤销已保存状态。沿用 `/api/personal/preferences` 接口和原归档规则。

基于当前线上应用镜像仅更新前端资源并同步源码及相关测试。备份：`/work/project/atlas-knowledge/backups/personal-preferences-20261010-114231`，包含数据库快照、前端源码/资源和环境配置，权限 600。发布目录：`/work/project/atlas-knowledge/releases/personal-preferences-20261010-114231`。

前端构建、格式检查及本地 3 项浏览器测试通过；在生产 HTTP 入口运行同一组 3 项隔离测试也通过，覆盖加载/保存等待、重复提交、状态持久化、键盘操作、保存失败重试、加载失败重试和 320px 手机布局。真实管理员只读验证开关状态与接口一致，开关使用 `rgb(36, 90, 205)`；验证前后原偏好保持一致，登录/退出正常，无浏览器脚本错误。线上入口、应用 JS 和 CSS 字节与本地构建一致。记录见 `personal-preferences-server-verification.json`。

API 健康、Worker 正常，均使用新镜像且重启次数为 0。环境配置校验和和数据卷挂载一致。

回滚应用和前端源码（保留业务数据）：

```bash
cd /work/project/atlas-knowledge
docker tag atlas-knowledge:before-personal-preferences-20261010-114231 atlas-knowledge:local
tar -xzf backups/personal-preferences-20261010-114231/frontend-and-config.tar.gz -C . frontend
rm -f frontend/e2e/personal-preferences.spec.ts
docker compose -p atlas-knowledge up -d --no-deps --no-build --wait --wait-timeout 180 api
docker compose -p atlas-knowledge up -d --no-deps --no-build worker
```
