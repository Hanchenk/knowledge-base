# 动态 Logo 加载页生产发布

发布日期：2026-10-12（Asia/Shanghai）。入口：[工作台](http://192.168.1.34:18088/app)。

版本：`atlas-knowledge:startup-logo-20261012-095856`。镜像 ID：`sha256:90017e1b1bfc9e7b46df9d4aa36b96d4ca90de36973a33fea9aa69b4dda186df`。上一镜像：`sha256:1996eae259d518c1fd1a3951a7cd44d692317f5d38fe08192cd5aa400ab84e3b`。

刷新页面时使用居中的现有彩色 Logo，带缓慢旋转、呼吸光晕和三个跳动圆点。首屏 HTML、应用代码下载和登录状态恢复共用相同画面，加载完成后立即进入页面。系统启用减少动态效果时停用装饰动画，保留读屏加载提示。

基于线上最新客户端连接版本，只更新六个前端源文件与构建资源。新镜像从当前应用镜像继承，保留旧版静态资源供已打开的页面使用。API 与 Worker 已切换到同一镜像；API 健康、Worker 运行，重启计数均为 0。后端、Agent、文档处理程序字节一致；环境配置、数据卷、基础设施容器和数据库 schema 10 保持一致。

验证：生产构建通过，41 个线上发布文件与构建逐字节一致。线上浏览器验证首屏 HTML、应用懒加载、登录状态等待、390/320px 布局、减少动态效果、真实管理员登录、工作台刷新、bot 目标页刷新和退出均通过，浏览器无脚本异常。两项现有登录/刷新与目标页浏览器测试通过。验证未创建生产任务。记录见 [生产验证](startup-production-verification.json)。

备份：`/work/project/atlas-knowledge/backups/startup-logo-20261012-095856`，包含受权限保护的数据库快照与前端/配置归档。发布目录：`/work/project/atlas-knowledge/releases/startup-logo-20261012-095856`。

回滚本次镜像及六个前端源文件，保留当前数据库和业务数据：

```bash
python3 /work/project/atlas-knowledge/releases/startup-logo-20261012-095856/release_control.py rollback
```
