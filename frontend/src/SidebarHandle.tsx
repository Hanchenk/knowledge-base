import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import "./sidebar-motion.css";

type Gesture = {
  pointer: number;
  startX: number;
  startWidth: number;
  fullWidth: number;
  width: number;
  wasOpen: boolean;
  moved: boolean;
  target: HTMLButtonElement;
};

export function useSidebar(mobile: boolean, onMobile: (open: boolean) => void) {
  const shell = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const frame = useRef(0);
  const suppressClick = useRef(false);
  const [desktop, setDesktop] = useState(
    () => window.matchMedia("(min-width: 761px)").matches,
  );
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("zhihui.sidebar.collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [dragging, setDragging] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const open = desktop ? !collapsed : mobile;
  const setOpen = (value: boolean) =>
    desktop ? setCollapsed(!value) : onMobile(value);
  const targetOpen = (current: Gesture) => {
    const distance = current.width - current.startWidth;
    // A deliberate swipe commits the direction; tiny movements snap to the nearest state.
    return Math.abs(distance) >= 48
      ? distance > 0
      : current.width >= current.fullWidth / 2;
  };
  const finish = (cancelled = false) => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = undefined;
    cancelAnimationFrame(frame.current);
    const next = cancelled ? current.wasOpen : targetOpen(current);
    if (current.moved) {
      suppressClick.current = true;
      // Release the immediate drag styles before letting the panels ease into their final position.
      shell.current?.classList.remove("sidebar-dragging");
      shell.current?.style.removeProperty("--sidebar-offset");
      setOpen(next);
    }
    setDragging(false);
    if (current.target.hasPointerCapture(current.pointer))
      current.target.releasePointerCapture(current.pointer);
  };
  const cancel = useRef(() => {});
  cancel.current = () => finish(true);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 761px)");
    const change = () => {
      cancel.current();
      onMobile(false);
      setDesktop(media.matches);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [onMobile]);
  useEffect(() => {
    try {
      localStorage.setItem("zhihui.sidebar.collapsed", collapsed ? "1" : "0");
    } catch {
      /* Storage is optional. */
    }
  }, [collapsed]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
    },
    [],
  );
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      !shell.current ||
      !panel.current
    )
      return;
    event.preventDefault();
    suppressClick.current = false;
    event.currentTarget.focus({ preventScroll: true });
    const bounds = panel.current.getBoundingClientRect();
    gesture.current = {
      pointer: event.pointerId,
      startX: event.clientX,
      startWidth: Math.max(0, bounds.right),
      fullWidth: bounds.width,
      width: Math.max(0, bounds.right),
      wasOpen: open,
      moved: false,
      target: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    const distance = event.clientX - current.startX;
    if (!current.moved && Math.abs(distance) < 5) return;
    if (!current.moved) {
      current.moved = true;
      shell.current?.classList.add("sidebar-dragging");
      setDragging(true);
    }
    current.width = Math.min(
      current.fullWidth,
      Math.max(0, current.startWidth + distance),
    );
    setPreviewOpen(targetOpen(current));
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() =>
      shell.current?.style.setProperty(
        "--sidebar-offset",
        `${current.width}px`,
      ),
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && gesture.current) {
      event.preventDefault();
      finish(true);
    } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      finish(true);
      setOpen(["ArrowRight", "End"].includes(event.key));
    }
  };
  return {
    shell,
    panel,
    open,
    desktop,
    dragging,
    className: `app-shell ${!open ? "sidebar-collapsed" : ""} ${dragging ? "sidebar-dragging" : ""}`,
    handle: {
      open,
      dragging,
      previewOpen,
      onPointerDown,
      onPointerMove,
      onKeyDown,
      onPointerUp: () => finish(),
      onPointerCancel: () => finish(true),
      onLostPointerCapture: () => finish(true),
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        const ignore = event.detail > 0 && suppressClick.current;
        suppressClick.current = false;
        if (!ignore) setOpen(!open);
      },
    },
  };
}

export function SidebarHandle({
  open,
  dragging,
  previewOpen,
  ...events
}: ReturnType<typeof useSidebar>["handle"]) {
  const hint = dragging
    ? previewOpen
      ? "松开展开"
      : "松开收起"
    : open
      ? "向左拖动收起"
      : "向右拖动展开";
  return (
    <button
      type="button"
      className="sidebar-handle"
      aria-label={open ? "收起系统侧边栏" : "展开系统侧边栏"}
      aria-expanded={open}
      aria-controls="system-sidebar"
      aria-describedby="sidebar-handle-hint"
      aria-keyshortcuts="ArrowLeft ArrowRight"
      {...events}
    >
      <span className="sidebar-handle-face" aria-hidden="true">
        <span className="sidebar-handle-grip">
          <i />
          <i />
        </span>
        <span className="sidebar-handle-arrow">
          {open ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
        </span>
      </span>
      <span className="sidebar-handle-hint" id="sidebar-handle-hint">
        {hint}
        <small>{dragging ? "" : "也可点击切换"}</small>
      </span>
    </button>
  );
}
