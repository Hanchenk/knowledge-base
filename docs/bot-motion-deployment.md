# 知小汇全对话区域小游戏与动画优化

生产入口：http://192.168.1.34:18088/app?view=bot 。部署时间：2026-10-10 17:18:12（Asia/Shanghai）。版本：`atlas-knowledge:zhixiaohui-motion-20261010-171254`。镜像 ID：`sha256:49b044a6a65409022ca0c11ad11f8505d7cee7c3c93d63f2d150792f03845a00`。

点击欢迎机器人后，输入栏向下滑出、欢迎内容淡出，游戏场景铺满对话内容区；分数、倒计时、退出和操作提示浮在场景边缘。无需弹窗，场景随窗口和侧边栏尺寸变化。退出后恢复原输入栏、草稿与工具选择，焦点返回入口。保留右侧工作区的用户选择，并支持游戏过程中收展工作区。

机器人和游戏共享浏览器帧时钟。机器人直接更新复用的 SVG 节点，星光和角色通过复用元素的 `translate3d` 移动；帧更新不再触发 React 重绘，指针事件也不再读取布局。React 仅在分数、整数秒数和游戏阶段变化时更新界面。游戏按实际活动时间计时，暂停不计时；暂停或结束后聚焦继续/重玩按钮，Esc 在焦点离开游戏后仍能退出。减少动态效果时停用装饰动画，保留操作所需的位移。

本次只更新前端组件、样式、动画渲染帮助文件及浏览器测试。后端和 Agent 运行时继承研究任务修复版本；没有创建生产任务或调用模型。

## 验证与测量

生产构建、修改文件的格式检查通过。12 项完整 bot 回归通过；扩展为全区域场景后，3 项本地和 3 项生产入口浏览器验证通过，覆盖视线、侧边栏定位、场景占满区域、草稿保存、暂停后焦点、无焦点时 Esc、键盘/触摸、计时、重玩与最佳成绩。原有流式输出、工具选择和侧边栏交互回归通过。

同一台机器的 Chrome，连续左右移动并观察 3 秒：修改前机器人约 23.0 帧/秒、游戏约 21.7 帧/秒；真实生产页面分别约 60.0 和 59.6 帧/秒，95% 更新间隔约 17.6 毫秒。浏览器四倍 CPU 降速模拟下，全区域游戏仍约 60.0 帧/秒。3 秒内 React 提交次数由机器人 70 次、游戏 69 次降至生产 fixture 的 1 次、4 次。

这些测量验证本机浏览器的连续更新节奏，其他设备的实际帧率取决于浏览器和硬件。真实生产登录验证桌面、390px 和 320px 手机、游戏过程中工作区收展、实际接星光、暂停/退出、草稿恢复及资源字节一致，浏览器无异常。

发布前后保留 1 个企业、37 个用户、4 个空间、5 份文档、4 个创作资产、schema 7、模型 revision 10；模型配置指纹、环境文件、数据卷、基础设施镜像和无关源码均一致。API/Worker 使用同一镜像，API 健康，重启次数为 0。

记录：[bot-motion-verification.json](bot-motion-verification.json)。截图：[桌面](screenshots/bot-inspiration-production-desktop.png) / [手机](screenshots/bot-inspiration-production-mobile.png)。

## 备份与回滚

备份：`/work/project/atlas-knowledge/backups/zhixiaohui-motion-20261010-171254`，含切换前数据库快照及源码/配置归档，权限 600。发布目录：`/work/project/atlas-knowledge/releases/zhixiaohui-motion-20261010-171254`。上一版本镜像：`atlas-knowledge:before-zhixiaohui-motion-20261010-171254`。

```bash
python3 /work/project/atlas-knowledge/releases/zhixiaohui-motion-20261010-171254/rollback.py zhixiaohui-motion-20261010-171254
```

回滚恢复本次前端源码、构建和 API/Worker 镜像，保留数据库、环境配置、模型设置与数据卷。
