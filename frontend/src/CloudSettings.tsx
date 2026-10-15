import { useEffect, useState } from "react";
import { Cloud, Download, Loader2, RefreshCw } from "lucide-react";
import { harnessApi, type HarnessStatus } from "./harness-api";
import type { Feedback } from "./App";

export function CloudSettings({ feedback }: { feedback: Feedback }) {
  const [status, setStatus] = useState<HarnessStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      setStatus(await harnessApi.status());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const update = async () => {
    setBusy(true);
    setError("");
    try {
      await harnessApi.update();
      setStatus(await harnessApi.status());
      feedback("云端服务已更新，将用于新任务");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="model-config panel" aria-label="云端服务配置">
      <div className="model-config-heading">
        <div>
          <h2>
            <Cloud size={20} /> 云端服务
          </h2>
          <p>
            统一维护运行环境。用户的插件、会话和成果文件保存在个人云端空间。
          </p>
        </div>
      </div>
      <article className="model-provider">
        <div className="model-provider-heading">
          <h3>DeepSeek Harness</h3>
          <span className="tiny-pill">
            {status?.available ? "服务已就绪" : busy ? "检测中" : "服务未就绪"}
          </span>
        </div>
        <p>
          当前版本：{status?.installed_version || "未安装"} · 最新版本：
          {status?.latest_version || "检测中"}
        </p>
        <p>
          每位用户独立使用云端电脑，空闲 30
          分钟自动释放运行资源；正在执行的任务会继续运行。重新连接后继续使用已保存的插件、会话和文件。
        </p>
        {(error || status?.error || status?.version_error) && (
          <p className="model-notice" role="alert">
            {error || status?.error || status?.version_error}
          </p>
        )}
        <div className="model-config-footer">
          <div>
            <button
              className="button"
              disabled={busy}
              onClick={() => void load()}
            >
              <RefreshCw size={14} /> 刷新状态
            </button>
            <button
              className="button primary"
              disabled={busy || !status?.is_admin}
              onClick={() => void update()}
            >
              {busy ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Download size={14} />
              )}{" "}
              {status?.installed_version ? "同步最新版本" : "安装云端服务"}
            </button>
          </div>
        </div>
      </article>
    </section>
  );
}
