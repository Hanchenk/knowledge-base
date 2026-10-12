import { ProductLogo } from "./ProductLogo";
import "./startup.css";

export function StartupScreen() {
  return (
    <div className="startup-screen" role="status" aria-live="polite">
      <div className="startup-screen-content">
        <div className="startup-screen-emblem" aria-hidden="true">
          <div className="startup-screen-turn">
            <ProductLogo className="startup-screen-logo" decorative />
          </div>
        </div>
        <div className="startup-screen-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span className="startup-screen-status">正在加载知汇…</span>
      </div>
    </div>
  );
}
