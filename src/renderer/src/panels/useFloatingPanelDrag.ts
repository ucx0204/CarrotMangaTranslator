import React, { useCallback, useEffect, useRef, useState } from "react";

type FloatingRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type DragState =
  | { mode: "move"; pointerId: number; offsetX: number; offsetY: number }
  | {
      mode: "resize";
      pointerId: number;
      startX: number;
      startY: number;
      startWidth: number;
      startHeight: number;
    };

type DragRef = React.MutableRefObject<DragState | null>;

type PointerHandlers = {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
};

const MIN_WIDTH = 320;
const MIN_HEIGHT = 280;

/**
 * Drag + resize state for an in-app floating panel. Rect is in-memory only;
 * the header drags the panel, the corner handle resizes it, both clamped to the
 * viewport. Pointer capture keeps moves tracked even past the panel bounds.
 */
export function useFloatingPanelDrag(storageKey: string): {
  rect: FloatingRect | null;
  moveHandlers: PointerHandlers;
  resizeHandlers: PointerHandlers;
} {
  const [rect, setRect] = useState<FloatingRect | null>(null);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    setRect(
      (current) => current ?? loadStoredRect(storageKey) ?? createInitialRect(),
    );
  }, [storageKey]);

  useEffect(() => {
    if (rect) {
      storeRect(storageKey, rect);
    }
  }, [storageKey, rect]);

  const endDrag = useCallback((event: React.PointerEvent) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  }, []);

  const onDragMove = useCallback((event: React.PointerEvent) => {
    setRect((current) => applyDrag(current, dragRef.current, event));
  }, []);

  return {
    rect,
    moveHandlers: {
      onPointerDown: (event) => beginMove(event, rect, dragRef),
      onPointerMove: onDragMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
    resizeHandlers: {
      onPointerDown: (event) => beginResize(event, rect, dragRef),
      onPointerMove: onDragMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}

function beginMove(
  event: React.PointerEvent,
  rect: FloatingRect | null,
  dragRef: DragRef,
): void {
  if (event.button !== 0 || !rect) {
    return;
  }
  if ((event.target as HTMLElement).closest("button")) {
    return;
  }
  event.currentTarget.setPointerCapture(event.pointerId);
  dragRef.current = {
    mode: "move",
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.x,
    offsetY: event.clientY - rect.y,
  };
}

function beginResize(
  event: React.PointerEvent,
  rect: FloatingRect | null,
  dragRef: DragRef,
): void {
  if (event.button !== 0 || !rect) {
    return;
  }
  event.currentTarget.setPointerCapture(event.pointerId);
  dragRef.current = {
    mode: "resize",
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: rect.width,
    startHeight: rect.height,
  };
}

function applyDrag(
  current: FloatingRect | null,
  drag: DragState | null,
  event: React.PointerEvent,
): FloatingRect | null {
  if (!current || !drag || drag.pointerId !== event.pointerId) {
    return current;
  }
  if (drag.mode === "move") {
    return clampRect({
      ...current,
      x: event.clientX - drag.offsetX,
      y: event.clientY - drag.offsetY,
    });
  }
  return clampRect({
    ...current,
    width: drag.startWidth + (event.clientX - drag.startX),
    height: drag.startHeight + (event.clientY - drag.startY),
  });
}

function createInitialRect(): FloatingRect {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(560, Math.max(MIN_WIDTH, viewportWidth * 0.55));
  const height = Math.min(720, Math.max(MIN_HEIGHT, viewportHeight * 0.82));
  return {
    width,
    height,
    x: Math.max(16, (viewportWidth - width) / 2),
    y: Math.max(16, (viewportHeight - height) / 2),
  };
}

function clampRect(rect: FloatingRect): FloatingRect {
  const maxWidth = window.innerWidth - 16;
  const maxHeight = window.innerHeight - 16;
  const width = Math.min(Math.max(MIN_WIDTH, rect.width), maxWidth);
  const height = Math.min(Math.max(MIN_HEIGHT, rect.height), maxHeight);
  return {
    width,
    height,
    x: Math.min(Math.max(0, rect.x), Math.max(0, window.innerWidth - width)),
    y: Math.min(Math.max(0, rect.y), Math.max(0, window.innerHeight - height)),
  };
}

function loadStoredRect(storageKey: string): FloatingRect | null {
  const parsed = parseRect(readLocalStorageItem(storageKey));
  return parsed ? clampRect(parsed) : null;
}

function readLocalStorageItem(storageKey: string): string | null {
  try {
    return window.localStorage.getItem(storageKey);
  } catch (error) {
    console.warn("Floating panel rect read failed", error);
    return null;
  }
}

function parseRect(raw: string | null): FloatingRect | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<FloatingRect>;
    const { x, y, width, height } = value;
    if (
      typeof x === "number" &&
      isFinite(x) &&
      typeof y === "number" &&
      isFinite(y) &&
      typeof width === "number" &&
      isFinite(width) &&
      typeof height === "number" &&
      isFinite(height)
    ) {
      return { x, y, width, height };
    }
  } catch (error) {
    console.warn("Floating panel rect parse failed", error);
  }
  return null;
}

function storeRect(storageKey: string, rect: FloatingRect): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(rect));
  } catch (error) {
    console.warn("Floating panel rect write failed", error);
  }
}
