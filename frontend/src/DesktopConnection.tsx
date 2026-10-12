import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  Laptop,
  Loader2,
  Link2,
  FolderOpen,
  ArrowUpRight,
} from "lucide-react";
import { api, post } from "./api";
import type { User } from "./types";
import "./desktop-connection.css";

type RequestInfo = {
  name: string;
  workspace_title: string;
  expires_at: number;
  connected: boolean;
};
const ports = [18765, 18766, 18767, 18768, 18769];
export function DesktopConnection({
  requestId,
  user,
}: {
  requestId: string;
  user: User;
}) {
  const [info, setInfo] = useState<RequestInfo>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [localClients, setLocalClients] = useState<string[]>([]);
  const [searching, setSearching] = useState(requestId === "local");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (requestId !== "local") {
      let disposed = false;
      api<RequestInfo>(`/api/bot/connections/${encodeURIComponent(requestId)}`)
        .then((value) => {
          if (!disposed) {
            setInfo(value);
            setConnected(value.connected);
          }
        })
        .catch((e) => {
          if (!disposed) setError(e.message);
        });
      return () => {
        disposed = true;
      };
    }
    const abort = new AbortController();
    let timer: number;
    const deadline = Date.now() + 60000;
    async function discover() {
      const results = await Promise.all(
        ports.map(async (port) => {
          const origin = `http://127.0.0.1:${port}`;
          try {
            const response = await fetch(`${origin}/health`, {
              credentials: "omit",
              signal: AbortSignal.any([
                abort.signal,
                AbortSignal.timeout(1500),
              ]),
            });
            const value = await response.json();
            return value.service === "zhixiaohui-desktop"
              ? { origin, connected: !!value.connected }
              : null;
          } catch {
            return null;
          }
        }),
      );
      if (abort.signal.aborted) return;
      const clients = results
        .filter((v): v is NonNullable<typeof v> => !!v)
        .sort((a, b) => Number(a.connected) - Number(b.connected));
      if (clients.length) {
        setLocalClients(clients.map((c) => c.origin));
        setSearching(false);
        if (clients.length === 1)
          window.location.replace(
            `${clients[0].origin}/connect?server=${encodeURIComponent(location.origin)}`,
          );
        return;
      }
      if (Date.now() < deadline)
        timer = window.setTimeout(() => void discover(), 2000);
      else setSearching(false);
    }
    setSearching(true);
    void discover();
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [requestId, retry]);
  async function approve() {
    setBusy(true);
    setError("");
    try {
      await post(
        `/api/bot/connections/${encodeURIComponent(requestId)}/approve`,
        {},
      );
      setConnected(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="desktop-connection-page">
      <section className="desktop-connection-card">
        <div
          className={`desktop-connection-symbol ${connected ? "connected" : ""}`}
        >
          {connected ? <Check size={27} /> : <Laptop size={27} />}
        </div>
        <span className="desktop-connection-eyebrow">知小汇 · 客户端连接</span>
        <h1>
          {connected
            ? "连接已确认"
            : requestId === "local"
              ? "连接你的电脑"
              : "让工作区与网页相连"}
        </h1>
        <p className="desktop-connection-intro">
          {connected
            ? "客户端会自动完成连接，回复与成果将同步到网页。"
            : requestId === "local"
              ? "打开 Harness 客户端，选择要连接的工作区。"
              : "确认这台电脑和工作区，连接到当前登录的账号。"}
        </p>
        {requestId === "local" ? (
          <>
            {localClients.length ? (
              localClients.map((origin, i) => (
                <a
                  className="desktop-connection-primary"
                  key={origin}
                  href={`${origin}/connect?server=${encodeURIComponent(location.origin)}`}
                >
                  <Link2 size={17} />
                  连接{localClients.length > 1 ? `客户端 ${i + 1}` : "此电脑"}
                  <ArrowRight size={17} />
                </a>
              ))
            ) : (
              <>
                <a
                  className="desktop-connection-primary"
                  href="dsh://open"
                  onClick={() => setRetry((v) => v + 1)}
                >
                  打开 Harness 客户端
                  <ArrowUpRight size={17} />
                </a>
                <p className="desktop-connection-detection" role="status">
                  {searching ? (
                    <>
                      <Loader2 size={14} className="spin" />
                      正在等待客户端…
                    </>
                  ) : (
                    "尚未发现客户端。请确认已安装最新版连接插件，然后重试。"
                  )}
                </p>
                {!searching && (
                  <button
                    className="desktop-connection-secondary"
                    onClick={() => setRetry((v) => v + 1)}
                  >
                    重新检测
                  </button>
                )}
                <a
                  className="desktop-connection-download"
                  href={`http://127.0.0.1:18765/connect?server=${encodeURIComponent(location.origin)}`}
                >
                  客户端已打开？直接连接此电脑 <ArrowRight size={13} />
                </a>
              </>
            )}
            <a
              className="desktop-connection-download"
              href="/downloads/dsh-plugin-team-hub-0.1.0-alpha.23.tgz"
              download
            >
              下载最新版连接插件 <ArrowUpRight size={13} />
            </a>
          </>
        ) : (
          <>
            {info && (
              <div className="desktop-connection-details">
                <div>
                  <Laptop size={17} />
                  <span>
                    电脑<strong>{info.name}</strong>
                  </span>
                </div>
                <div>
                  <FolderOpen size={17} />
                  <span>
                    工作区<strong>{info.workspace_title}</strong>
                  </span>
                </div>
                <div className="desktop-connection-account">
                  连接账号 <strong>{user.name}</strong>
                </div>
              </div>
            )}
            {!connected && info && (
              <>
                <p className="desktop-connection-disclosure">
                  此工作区已有会话和新会话会同步到你的账号。网页任务使用客户端的模型与工具权限。
                </p>
                <button
                  className="desktop-connection-primary"
                  disabled={busy}
                  onClick={() => void approve()}
                >
                  {busy ? (
                    <Loader2 size={17} className="spin" />
                  ) : (
                    <Link2 size={17} />
                  )}
                  确认连接
                  <ArrowRight size={17} />
                </button>
              </>
            )}
            {connected && (
              <a className="desktop-connection-primary" href="/app?view=bot">
                返回知小汇
                <ArrowRight size={17} />
              </a>
            )}
          </>
        )}
        {error && (
          <p className="desktop-connection-error" role="alert">
            {error}
          </p>
        )}
        <a className="desktop-connection-back" href="/app?view=bot">
          {connected ? "可以关闭此窗口" : "暂不连接，返回网页"}
        </a>
      </section>
    </main>
  );
}
