"use client";

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

export type Option = {
  value: string;
  label: string;
  /** Quiet text on the right of the row. */
  hint?: string;
  group?: string;
  icon?: ReactNode;
  disabled?: boolean;
};

type Props = {
  label: string;
  value: string | null;
  options: Option[];
  onChange: (value: string) => void;
  placeholder: string;
  /** Adds a search field. */
  searchPlaceholder?: string;
  /** Shown in place of the list when there is nothing to choose. */
  emptyText?: string;
  footer?: ReactNode;
  className?: string;
};

const GAP = 4;
const MAX_HEIGHT = 320;

/**
 * A dropdown with a keyboard-driven list. It uses the browser's own popover
 * layer, so it is never clipped and Escape or a click outside closes it.
 */
export function Select({
  label,
  value,
  options,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyText = "Nothing to choose from.",
  footer,
  className = "",
}: Props) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const typed = useRef({ text: "", at: 0 });

  const selected = options.find((option) => option.value === value);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? options.filter((o) => o.label.toLowerCase().includes(needle))
      : options;
  }, [options, query]);

  const place = useCallback(() => {
    const button = buttonRef.current;
    const panel = panelRef.current;
    if (!button || !panel) return;
    const rect = button.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - GAP - 12;
    const above = rect.top - GAP - 12;
    const up = below < 220 && above > below;
    const width = Math.max(rect.width, 240);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    panel.style.maxHeight = `${Math.min(MAX_HEIGHT, up ? above : below)}px`;
    panel.style.top = up ? "auto" : `${rect.bottom + GAP}px`;
    panel.style.bottom = up
      ? `${window.innerHeight - rect.top + GAP}px`
      : "auto";
    panel.style.transformOrigin = up ? "bottom" : "top";
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  // Keep the highlighted row in view.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function choose(option: Option | undefined) {
    if (!option || option.disabled) return;
    onChange(option.value);
    panelRef.current?.hidePopover();
    buttonRef.current?.focus();
  }

  function step(from: number, by: 1 | -1) {
    for (let i = from + by; i >= 0 && i < shown.length; i += by) {
      if (!shown[i].disabled) return i;
    }
    return from;
  }

  function onKeyDown(event: KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((index) => step(index, 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        setActive((index) => step(index, -1));
        return;
      case "Enter":
        event.preventDefault();
        choose(shown[active]);
        return;
      case "Tab":
        panelRef.current?.hidePopover();
        return;
    }
    if (searchPlaceholder) return;
    if (event.key === "Home") setActive(step(-1, 1));
    if (event.key === "End") setActive(step(shown.length, -1));
    if (event.key.length === 1) {
      // Type the first letters of an option to jump to it.
      const now = Date.now();
      const text =
        (now - typed.current.at < 700 ? typed.current.text : "") + event.key;
      typed.current = { text, at: now };
      const hit = shown.findIndex(
        (o) =>
          !o.disabled && o.label.toLowerCase().startsWith(text.toLowerCase()),
      );
      if (hit >= 0) setActive(hit);
    }
  }

  return (
    <div className={className}>
      <button
        ref={buttonRef}
        type="button"
        popoverTarget={`${id}-panel`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${selected?.label ?? placeholder}`}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            panelRef.current?.showPopover();
          }
        }}
        className="field flex h-9 w-full items-center gap-2 px-2.5 text-left text-[13px]"
      >
        {selected?.icon}
        <span
          className={`min-w-0 flex-1 truncate ${selected ? "text-ink" : "text-muted"}`}
        >
          {selected?.label ?? placeholder}
        </span>
        <svg
          viewBox="0 0 16 16"
          className={`size-3.5 shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6.5 8 10.5 12 6.5" />
        </svg>
      </button>

      <div
        ref={panelRef}
        id={`${id}-panel`}
        popover="auto"
        className="menu"
        onBeforeToggle={(event) => {
          if (event.newState === "open") {
            setQuery("");
            setActive(
              Math.max(
                0,
                options.findIndex((o) => o.value === value),
              ),
            );
            place();
          }
        }}
        onToggle={(event) => {
          const isOpen = event.newState === "open";
          setOpen(isOpen);
          if (isOpen) (searchRef.current ?? listRef.current)?.focus();
        }}
      >
        {searchPlaceholder && options.length > 0 && (
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            role="combobox"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-activedescendant={`${id}-${active}`}
            autoComplete="off"
            spellCheck={false}
            className="h-9 w-full shrink-0 border-b border-ink/10 bg-transparent px-3 text-[13px] text-ink outline-none placeholder:text-muted"
          />
        )}
        <div
          ref={listRef}
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          aria-activedescendant={
            shown.length > 0 ? `${id}-${active}` : undefined
          }
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 outline-none"
        >
          {shown.length === 0 && (
            <p className="px-2 py-2 text-[13px] text-muted">
              {query ? `No match for "${query}".` : emptyText}
            </p>
          )}
          {shown.map((option, index) => (
            <div key={option.value}>
              {option.group && option.group !== shown[index - 1]?.group && (
                <p
                  className={`px-2 pb-1 text-xs text-muted ${index > 0 ? "mt-1 border-t border-ink/8 pt-2" : "pt-1"}`}
                >
                  {option.group}
                </p>
              )}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: the list handles keys through aria-activedescendant */}
              {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the list */}
              <div
                id={`${id}-${index}`}
                data-index={index}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled}
                onClick={() => choose(option)}
                onPointerMove={() => !option.disabled && setActive(index)}
                className={`flex h-8 items-center gap-2 rounded px-2 text-[13px] ${
                  option.disabled
                    ? "cursor-not-allowed text-muted opacity-60"
                    : "cursor-default text-ink"
                } ${index === active && !option.disabled ? "bg-ink/7" : ""}`}
              >
                {option.icon}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint && (
                  <span className="shrink-0 text-xs text-muted">
                    {option.hint}
                  </span>
                )}
                <svg
                  viewBox="0 0 16 16"
                  className={`size-3.5 shrink-0 ${option.value === value ? "" : "invisible"}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
                </svg>
              </div>
            </div>
          ))}
        </div>
        {footer && (
          <div className="shrink-0 border-t border-ink/10 p-1">{footer}</div>
        )}
      </div>
    </div>
  );
}
