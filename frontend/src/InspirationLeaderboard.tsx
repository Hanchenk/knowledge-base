import { useEffect, useRef } from "react";
import { ArrowLeft, RotateCcw, Star, Trophy, X } from "lucide-react";

export type InspirationEntry = {
  user_id: string;
  name: string;
  score: number;
  rank: number;
  is_me: boolean;
};
export type InspirationStandings = {
  entries: InspirationEntry[];
  me: InspirationEntry | null;
  total: number;
  submitted_score?: number;
};

export function InspirationLeaderboard({
  standings,
  score,
  loading,
  error,
  starting,
  startError,
  onRetry,
  onReplay,
  onReturn,
  onClose,
}: {
  standings: InspirationStandings | null;
  score: number;
  loading: boolean;
  error: string;
  starting: boolean;
  startError: string;
  onRetry: () => void;
  onReplay: () => void;
  onReturn: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="inspiration-ranking"
      aria-labelledby="inspiration-ranking-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="inspiration-ranking-heading">
        <span>
          <Trophy size={17} />
          <h2 id="inspiration-ranking-title">企业灵感榜</h2>
        </span>
        <button onClick={onClose} aria-label="收起排行榜" autoFocus>
          <X size={18} />
        </button>
      </header>
      <div className="inspiration-ranking-content">
        <p className="inspiration-ranking-intro">和同事一起，接住好灵感</p>
        <div className="inspiration-ranking-result">
          <div>
            <span>本次星光</span>
            <strong>
              {score}
              <Star size={16} />
            </strong>
          </div>
          <div>
            <span>个人最佳</span>
            <strong>{standings?.me?.score ?? "—"}</strong>
          </div>
          <div>
            <span>企业名次</span>
            <strong>
              {standings?.me ? `第 ${standings.me.rank} 名` : "—"}
            </strong>
          </div>
        </div>
        <div className="inspiration-ranking-list" aria-busy={loading}>
          {loading ? (
            <p className="inspiration-ranking-message" role="status">
              <span className="inspiration-ranking-loader" />
              正在保存成绩，更新企业榜单…
            </p>
          ) : error ? (
            <div className="inspiration-ranking-message" role="alert">
              <p>成绩尚未确认保存，重试后即可上榜。</p>
              <small>{error}</small>
              <button className="inspiration-start" onClick={onRetry}>
                重试保存成绩
              </button>
            </div>
          ) : (
            <>
              <div className="inspiration-ranking-columns">
                <span>名次 / 成员</span>
                <span>最高星光</span>
              </div>
              <ol aria-label="企业成员排行榜">
                {standings?.entries.map((entry) => (
                  <li
                    key={entry.user_id}
                    className={entry.is_me ? "is-me" : ""}
                  >
                    <span
                      className={`inspiration-ranking-place place-${entry.rank}`}
                    >
                      {entry.rank <= 3 ? (
                        <Trophy size={15} aria-hidden="true" />
                      ) : null}
                      {entry.rank}
                    </span>
                    <span
                      className="inspiration-ranking-name"
                      title={entry.name}
                    >
                      {entry.name}
                    </span>
                    {entry.is_me && (
                      <small className="inspiration-ranking-you">你</small>
                    )}
                    <strong>
                      {entry.score}
                      <Star size={12} />
                    </strong>
                  </li>
                ))}
              </ol>
              {standings?.me &&
                !standings.entries.some((entry) => entry.is_me) && (
                  <div
                    className="inspiration-ranking-own"
                    aria-label="你的榜单成绩"
                  >
                    <span>
                      第 {standings.me.rank} 名 · {standings.me.name}
                    </span>
                    <strong>{standings.me.score} 颗星光</strong>
                  </div>
                )}
              <p className="inspiration-ranking-note">
                {standings?.total ?? 0} 位成员已参与 · 展示前 10 位<br />
                按个人最高成绩排名，同分并列
              </p>
            </>
          )}
        </div>
        <footer className="inspiration-ranking-actions">
          {startError && (
            <p className="inspiration-start-error" role="alert">
              {startError}
            </p>
          )}
          <button
            className="inspiration-start"
            onClick={onReplay}
            disabled={loading || !!error || starting}
          >
            <RotateCcw size={15} />
            {starting ? "正在准备…" : "再玩一次"}
          </button>
          <button className="inspiration-return" onClick={onReturn}>
            <ArrowLeft size={14} />
            回到对话
          </button>
        </footer>
      </div>
    </dialog>
  );
}
