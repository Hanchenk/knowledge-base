# A 版正式首页验证

2026-10-10，用户选择 A 后接入正式 React 入口。

- `npm run build` 通过，TypeScript 检查与 Vite 生产构建成功。
- 修改的前端源文件、入口 HTML 和浏览器测试通过 Prettier 格式检查。
- `npx playwright test e2e/landing.spec.ts`：4 项通过。覆盖首页不请求企业 API、问答示例、FAQ、390/320px 布局、手机菜单与 Escape、登录/退出/刷新、首页返回及问答/创作目标保留。
- `cargo fmt --all -- --check` 通过。
- `cargo test --workspace --locked`：2 项单元测试和 25 项集成测试通过。测试使用隔离数据与服务。
- 实际生产构建通过现有 Rust 服务的静态资源入口检查：使用浏览器请求代理将当前已配置的公开来源 `http://127.0.0.1:5173` 转至 Rust 服务的 8000 端口，保留受信任 Origin；根地址展示官网，`/app` 和 `/login` 展示登录页面，返回官网正常，无浏览器页面错误。
- 官网实际渲染截图：docs/screenshots/homepage-desktop.png、homepage-full.png、homepage-mobile.png、homepage-mobile-hero.png。

浏览器登录测试使用本地拦截的独立会话与企业数据，不修改现有企业配置。生产入口检查使用未登录的独立浏览器上下文。第三方 OIDC 服务未进行端到端登录，代码已将成功回调的落点改为 `/app`。

当前开发配置信任 5173 的站点来源；直接通过浏览器访问裸 8000 端口时，模块脚本与样式携带的不同 Origin 被现有来源校验拒绝。来源校验未修改；正式部署仍需将 PUBLIC_URL 与实际公开站点地址保持一致。
