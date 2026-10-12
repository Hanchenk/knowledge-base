# 知汇官网首页

当前首页主打知小汇 bot：首屏「这里是知汇」逐字入场，使用用户上传的品牌字体和动态光影视频。互动界面直接融入首页，支持三个任务示例、成果下载、机器人视线与访客小游戏；输入框可编辑，发送后进入 `/login?view=bot`，登录后恢复输入内容，由用户再次发送执行任务。登录页沿用官网动态背景和品牌字体。

官网：[http://192.168.1.34:18088/](http://192.168.1.34:18088/)。当前发布、备份和回滚信息见 `server-deployment.md`；本次实际线上验证见 `server-login-verification.json`。正式入口、减少动态效果、移动导航与 API 隔离由 `frontend/e2e/landing.spec.ts` 验证。


用户已选择 A 自然光影，正式首页已经接入当前 React 应用。

已部署至服务器：http://192.168.1.34:18088/ 。发布版本与回滚信息见 server-deployment.md，真实浏览器验证记录见 server-verification.json；新版 Logo 截图与视频背景验证见 server-video-verification.json；产品名称及上传字体验证见 server-brand-verification.json。

- 官网首页：http://127.0.0.1:5173/
- 登录：http://127.0.0.1:5173/login
- 工作台：http://127.0.0.1:5173/app
- 问答直达：`/app?view=chat`
- 创作直达：`/app?view=studio`

正式实现位于 frontend/src/LandingPage.tsx 和 frontend/src/landing.css，截图资源在 frontend/src/assets/landing。首页使用独立样式作用域，工作台与其样式按需加载；访问首页不请求企业 API。未登录访问功能入口时先显示登录，登录后保留目标功能。OIDC 回调重定向到 `/app`。

三个初稿保留用于对照：

现有开发服务预览：http://127.0.0.1:5173/homepage-designs/index.html

- A 自然光影：frontend/public/homepage-designs/a-daylight.html，主方向，参考 Today AI。
- B 品牌蓝白：frontend/public/homepage-designs/b-brand-blue.html，品牌配色轻量变体。
- C 深色企业：frontend/public/homepage-designs/c-forest-ink.html，深色与分栏轻量变体。

初稿文件将 Logo 与截图嵌入，不依赖网络字体、脚本和图片服务。初稿的入口链接仍指向 `/`，即正式官网；正式首页入口指向 `/app` 和 `/login`。页内交互与锚点可以直接使用。

修改文案或视觉后，在仓库根目录执行 `python3 docs/homepage/generate-previews.py` 重新生成三个 HTML。对比页与截图不会被该命令覆盖。

来源、假设和功能边界见 design-spec.md、brand-spec.md 与 product-facts.md。方向确认见 direction-approved.md。初稿浏览器检查记录见 verification.json；正式首页入口、登录回跳、移动导航与 API 隔离由 frontend/e2e/landing.spec.ts 验证。
