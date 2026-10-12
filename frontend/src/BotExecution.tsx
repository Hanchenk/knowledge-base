import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Cloud,
  Laptop,
  Link2,
  Loader2,
  Trash2,
} from "lucide-react";
import type { LocalDevice } from "./bot-types";
import { api } from "./api";

export function BotExecution({
  devices,
  deviceId,
  onSelect,
  onRefresh,
}: {
  devices: LocalDevice[];
  deviceId: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const dropdown = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const choices = useRef<(HTMLButtonElement | null)[]>([]);
  const focusIndex = useRef(0);
  const menuId = useId();
  const selected = devices.find((device) => device.id === deviceId);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const previousDevices = useRef(new Set<string>());

  useEffect(() => {
    refresh.current();
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const frame = requestAnimationFrame(() =>
      choices.current[focusIndex.current]?.focus(),
    );
    const dismiss = (event: PointerEvent) => {
      if (!dropdown.current?.contains(event.target as Node)) setExpanded(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [expanded, devices.length]);
  useEffect(() => {
    if (!connecting) return;
    const timer = window.setInterval(() => refresh.current(), 3000);
    const stop = window.setTimeout(() => setConnecting(false), 600000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [connecting]);
  useEffect(() => {
    if (!connecting) return;
    const added = devices.find(
      (device) => !previousDevices.current.has(device.id) && device.online,
    );
    if (added) {
      onSelect(added.id);
      setConnecting(false);
    }
  }, [devices, connecting, onSelect]);

  function openMenu(
    index = Math.max(
      0,
      devices.findIndex((d) => d.id === deviceId),
    ),
  ) {
    focusIndex.current = index;
    setExpanded(true);
    refresh.current();
  }
  function closeMenu() {
    setExpanded(false);
    trigger.current?.focus();
  }
  async function remove(device: LocalDevice) {
    setRemoving(device.id);
    setError("");
    try {
      await api(`/api/bot/devices/${encodeURIComponent(device.id)}`, {
        method: "DELETE",
      });
      if (deviceId === device.id) onSelect("");
      closeMenu();
      refresh.current();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRemoving("");
    }
  }
  function connect() {
    previousDevices.current = new Set(devices.map((device) => device.id));
    const opened = window.open("/app?view=bot&connect=local", "_blank");
    if (opened) {
      opened.opener = null;
      setConnecting(true);
      setError("");
    } else setError("浏览器拦截了连接窗口，请允许弹窗后重试");
    // The link's default action requests dsh://open within this user gesture.
  }

  return (
    <div className="bot-execution">
      <button
        type="button"
        className={`bot-execution-choice ${!deviceId ? "selected" : ""}`}
        aria-pressed={!deviceId}
        onClick={() => onSelect("")}
      >
        <span className="bot-execution-glyph">
          <Cloud size={18} />
        </span>
        <span className="bot-execution-label">
          <strong>云端执行</strong>
        </span>
        {!deviceId && <Check size={16} className="bot-execution-check" />}
      </button>
      <div
        className="bot-local-dropdown"
        ref={dropdown}
        onBlur={(event) => {
          if (
            event.relatedTarget &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            setExpanded(false);
        }}
      >
        <button
          type="button"
          ref={trigger}
          className={`bot-execution-choice bot-local-trigger ${deviceId ? "selected" : ""}`}
          aria-label={
            selected
              ? `本地电脑：${selected.name} · ${selected.workspace_title}`
              : "本地电脑"
          }
          aria-haspopup="menu"
          aria-expanded={expanded}
          aria-controls={expanded ? menuId : undefined}
          onClick={() => (expanded ? setExpanded(false) : openMenu())}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              openMenu(
                event.key === "ArrowUp"
                  ? Math.max(0, devices.length - 1)
                  : undefined,
              );
            }
          }}
        >
          <span className="bot-execution-glyph">
            <Laptop size={18} />
          </span>
          <span className="bot-execution-label">
            <strong>本地电脑</strong>
            {selected && (
              <small>
                {selected.name} · {selected.workspace_title}
              </small>
            )}
          </span>
          {selected && (
            <span
              className={`bot-device-dot ${selected.online ? "online" : ""}`}
              aria-label={selected.online ? "在线" : "离线"}
            />
          )}
          <ChevronDown size={16} className="bot-local-chevron" />
        </button>
        {expanded && (
          <div
            className="bot-local-menu"
            role="menu"
            aria-label="本地电脑工作区"
            id={menuId}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeMenu();
              } else if (
                ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                if (!devices.length) return;
                const option = (event.target as Element).closest<HTMLElement>(
                  "[data-device-index]",
                );
                const index = Number(option?.dataset.deviceIndex ?? 0);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? devices.length - 1
                      : (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          devices.length) %
                        devices.length;
                choices.current[next]?.focus();
              }
            }}
          >
            {devices.length ? (
              devices.map((device, index) => (
                <div
                  className="bot-local-option"
                  role="none"
                  key={device.id}
                  data-device-index={index}
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    disabled={!!removing}
                    aria-checked={deviceId === device.id}
                    aria-label={`${device.name} · ${device.workspace_title}`}
                    title={`${device.name} · ${device.workspace_title}`}
                    className="bot-local-option-select"
                    ref={(element) => {
                      choices.current[index] = element;
                    }}
                    onClick={() => {
                      onSelect(device.id);
                      closeMenu();
                    }}
                  >
                    <span className="bot-execution-label">
                      <strong>{device.name}</strong>
                      <small>{device.workspace_title || device.name}</small>
                    </span>
                    <span
                      className={`bot-device-presence ${device.online ? "online" : ""}`}
                    >
                      <i />
                      {device.online ? "在线" : "离线"}
                    </span>
                    <span className="bot-local-option-check">
                      {deviceId === device.id && <Check size={14} />}
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="bot-local-delete"
                    aria-label={`删除连接 ${device.name} · ${device.workspace_title}`}
                    title="删除连接"
                    disabled={!!removing}
                    onClick={() => void remove(device)}
                  >
                    {removing === device.id ? (
                      <Loader2 size={15} className="spin" />
                    ) : (
                      <Trash2 size={15} />
                    )}
                  </button>
                </div>
              ))
            ) : (
              <div className="bot-local-empty" role="none">
                暂无已连接电脑
              </div>
            )}
          </div>
        )}
      </div>
      <a
        className="bot-execution-connect"
        href="dsh://open"
        role="button"
        aria-label="连接本地"
        aria-busy={connecting}
        onClick={connect}
        onKeyDown={(event) => {
          if (event.key === " ") {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      >
        <Link2 size={17} />
        <span>{connecting ? "正在连接…" : "连接本地"}</span>
        {connecting ? (
          <Loader2 size={15} className="spin" />
        ) : (
          <ArrowUpRight size={15} />
        )}
      </a>
      {error && (
        <p className="bot-local-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
