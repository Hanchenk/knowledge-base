import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { LoaderCircle, LogOut, UserRound } from "lucide-react";
import type { User } from "./types";
import { api } from "./api";
import { Modal } from "./components";

type PersonalPreferences = {
  auto_archive: boolean;
  space_id: string | null;
};

export function AccountMenu({
  user,
  tenantName,
  busy,
  onProfile,
  onLogout,
  trigger,
}: {
  user: User;
  tenantName: string;
  busy: boolean;
  onProfile: () => void;
  onLogout: () => Promise<void>;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    menu.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    const focus = (event: FocusEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    document.addEventListener("focusin", focus);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("focusin", focus);
    };
  }, [open]);

  return (
    <div className="account-control" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`avatar small account-trigger ${open ? "active" : ""}`}
        aria-label="账号菜单"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {user.name.slice(-2)}
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="账号操作"
          className="account-menu"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const items = Array.from(
              menu.current?.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]:not(:disabled)',
              ) || [],
            );
            if (!items.length) return;
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                    items.length;
            items[next]?.focus();
          }}
        >
          <div className="account-menu-identity" role="presentation">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
            <small>{tenantName}</small>
          </div>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              trigger.current?.focus();
              onProfile();
            }}
          >
            <UserRound size={16} />
            个人中心
          </button>
          <button
            type="button"
            role="menuitem"
            className="account-logout"
            disabled={busy}
            onClick={() => void onLogout()}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <LogOut size={16} />
            )}
            {busy ? "正在登出…" : "登出"}
          </button>
        </div>
      )}
    </div>
  );
}

export function PersonalCenter({
  user,
  tenantName,
  onClose,
  onSaved,
}: {
  user: User;
  tenantName: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [preferences, setPreferences] = useState<PersonalPreferences>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const pending = useRef(false);
  const descriptionId = useId();
  const loadPreferences = async () => {
    setLoading(true);
    setError("");
    try {
      setPreferences(
        await api<PersonalPreferences>("/api/personal/preferences"),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void loadPreferences();
  }, []);
  const toggleArchive = async () => {
    if (!preferences || pending.current) return;
    pending.current = true;
    const previous = preferences;
    const auto_archive = !previous.auto_archive;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const updated = await api<PersonalPreferences>(
        "/api/personal/preferences",
        { method: "PUT", body: JSON.stringify({ auto_archive }) },
      );
      setPreferences(updated);
      setSaved(true);
    } catch (e) {
      setError(`保存失败：${(e as Error).message}。请重试。`);
      return;
    } finally {
      pending.current = false;
      setBusy(false);
    }
    // Refresh the workspace separately: a refresh failure must not undo a saved preference.
    try {
      await onSaved();
    } catch {
      setError("设置已保存，知识库列表刷新失败，请刷新页面。");
    }
  };
  return (
    <Modal title="个人中心" onClose={onClose}>
      <div className="personal-identity">
        <div className="avatar">{user.name.slice(-2)}</div>
        <div>
          <strong>{user.name}</strong>
          <span>{user.email}</span>
        </div>
      </div>
      <dl className="personal-details">
        {[
          ["姓名", user.name],
          ["邮箱", user.email],
          ["所属企业", tenantName],
          ["账号身份", user.role === "admin" ? "企业管理员" : "企业成员"],
          ["账号状态", user.active ? "正常" : "已停用"],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="personal-preferences">
        <div className="personal-preferences-header">
          <strong>创作内容自动入库</strong>
          <div className="personal-preferences-control">
            <span role="status" aria-live="polite">
              {(loading || busy) && (
                <LoaderCircle size={13} className="spin" aria-hidden="true" />
              )}
              {loading
                ? "加载中…"
                : busy
                  ? "保存中…"
                  : !preferences
                    ? "未加载"
                    : preferences.auto_archive
                      ? "已开启"
                      : "已关闭"}
            </span>
            <button
              type="button"
              role="switch"
              className="personal-preferences-switch"
              aria-label="创作内容自动入库"
              aria-describedby={descriptionId}
              aria-checked={preferences?.auto_archive ?? false}
              disabled={loading || busy || !preferences}
              onClick={() => void toggleArchive()}
            >
              <span aria-hidden="true" />
            </button>
          </div>
        </div>
        <p id={descriptionId}>
          开启后，新生成的图片和视频会自动保存到个人知识库，仅本人可访问。关闭后停止自动入库，已保存内容保留。
        </p>
        <div className="personal-preferences-footer">
          <small>{saved ? "设置已保存" : "更改后自动保存"}</small>
          {!preferences && !loading && (
            <button
              type="button"
              className="text-button"
              onClick={() => void loadPreferences()}
            >
              重新加载
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="notice error-notice">
            {error}
          </p>
        )}
      </div>
      <div className="form-actions">
        <button type="button" className="button primary" onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}
