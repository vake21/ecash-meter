"use client";

// A sidechain's name that reveals its description on demand:
//   - mouse: hover the name
//   - touch: tap the name (tap anywhere else, or tap it again, to close)
//   - keyboard: tab to it (Escape closes)
//
// A JS toggle rather than CSS :hover because touch screens have no hover (and
// Tailwind v4 only applies hover styles on hover-capable pointers), and Safari
// doesn't focus a tapped button. The popup is portalled to <body> with fixed
// positioning so it can't be clipped by the table's scroll container; it opens
// below the name, or above when there isn't room.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  name: string;
  description: string;
  className?: string;
}

const WIDTH = 288; // px; the popup's max width
const GAP = 6;
const MARGIN = 8; // keep clear of the viewport edge

export default function SidechainName({ name, description, className = "" }: Props) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLSpanElement>(null);
  // Three independent reasons to be open, so they can't cancel each other out:
  // a click/tap focuses the button AND clicks it, and treating those as one
  // toggle would open and immediately close it.
  const [hovered, setHovered] = useState(false); // mouse over the name
  const [pinned, setPinned] = useState(false); // toggled by click / tap / Enter
  const [keyFocus, setKeyFocus] = useState(false); // keyboard focus only
  const open = hovered || pinned || keyFocus;
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null);

  const place = useCallback(() => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN);
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - width - MARGIN));
    const popupH = popup.current?.offsetHeight ?? 80;
    const above = r.bottom + GAP + popupH > window.innerHeight && r.top - GAP - popupH > 0;
    setPos({ top: above ? r.top - GAP : r.bottom + GAP, left, above });
  }, []);

  const hide = useCallback(() => {
    setHovered(false);
    setPinned(false);
    setKeyFocus(false);
  }, []);

  // While open: close on an outside tap/click, Escape, scroll or resize.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !popup.current?.contains(t)) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  if (!description) return <span className={className}>{name}</span>;

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        className={`cursor-help text-left underline decoration-white/25 decoration-dotted underline-offset-4 transition-colors hover:decoration-white/60 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${className}`}
        onPointerEnter={(e) => {
          if (e.pointerType !== "mouse") return;
          place();
          setHovered(true);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setHovered(false);
        }}
        onClick={() => {
          place();
          setPinned((p) => !p);
        }}
        onFocus={(e) => {
          // Only keyboard focus opens it; the focus a click causes doesn't.
          if (e.currentTarget.matches(":focus-visible")) {
            place();
            setKeyFocus(true);
          }
        }}
        onBlur={() => {
          setKeyFocus(false);
          setPinned(false);
        }}
      >
        {name}
      </button>
      {open && pos
        ? createPortal(
            <span
              ref={popup}
              id={id}
              role="tooltip"
              style={{
                position: "fixed",
                top: pos.top,
                left: pos.left,
                maxWidth: Math.min(WIDTH, window.innerWidth - 2 * MARGIN),
                transform: pos.above ? "translateY(-100%)" : undefined,
              }}
              className="z-50 block rounded-lg border border-white/10 bg-neutral-900/95 px-3 py-2 text-xs leading-relaxed text-neutral-200 shadow-xl backdrop-blur"
            >
              {description}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
