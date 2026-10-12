import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X } from "lucide-react";

export function StudioOptionsPopover({
  label,
  caption,
  summary,
  title,
  icon,
  className,
  open,
  disabled,
  onToggle,
  onClose,
  children,
}: {
  label: string;
  caption?: string;
  summary: string;
  title?: string;
  icon: ReactNode;
  className: string;
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  }>();

  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined);
      return;
    }
    const place = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const width = Math.min(380, window.innerWidth - 24);
      const below = window.innerHeight - anchor.bottom - 12;
      const above = anchor.top - 12;
      const desiredHeight = panel.current.scrollHeight;
      const down = below >= desiredHeight + 8 || below >= above;
      const maxHeight = Math.max(0, (down ? below : above) - 8);
      const height = Math.min(desiredHeight, maxHeight);
      const next = {
        top: down ? anchor.bottom + 8 : anchor.top - height - 8,
        left: Math.max(
          12,
          Math.min(anchor.left, window.innerWidth - width - 12),
        ),
        maxHeight,
      };
      setPosition((current) =>
        current?.top === next.top &&
        current.left === next.left &&
        current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const first =
      panel.current?.querySelector<HTMLElement>("select:not(:disabled)") ||
      panel.current?.querySelector<HTMLElement>("button");
    first?.focus({ preventScroll: true });
    const contains = (target: EventTarget | null) =>
      trigger.current?.contains(target as Node) ||
      panel.current?.contains(target as Node);
    const outside = (event: PointerEvent) => {
      if (!contains(event.target)) onClose();
    };
    const focus = (event: FocusEvent) => {
      if (!contains(event.target)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focus);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("keydown", escape);
    };
  }, [open, onClose]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`studio-toolbar-chip ${className} ${open ? "active" : ""}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={title}
        disabled={disabled}
        onClick={onToggle}
      >
        {icon}
        {caption && <span className="studio-chip-caption">{caption}</span>}
        <span className="studio-chip-summary">{summary}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-label={label}
            className="studio-options-panel"
            style={{ ...position, visibility: position ? "visible" : "hidden" }}
          >
            <div className="studio-options-heading">
              <strong>{label}</strong>
              <button
                type="button"
                className="icon-button"
                aria-label={`关闭${label}`}
                onClick={() => {
                  onClose();
                  trigger.current?.focus({ preventScroll: true });
                }}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>
            <div className="studio-options-fields">{children}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
