import { useCallback, useEffect, useRef, useState } from 'react';
import { BookNote } from '@/types/book';
import {
  buildDirectedRange,
  getAutoScrollEdge,
  Point,
  TextSelection,
  type CaretPosition,
  type ScrollEdge,
} from '@/utils/sel';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';

interface HandlePositions {
  start: Point;
  end: Point;
}

// Thickness (px) of the viewport edge band that triggers auto-scroll while a
// handle is dragged there, and how fast/often we scroll and rebuild the range.
const EDGE_BAND = 56;
const AUTO_SCROLL_STEP = 8;
const APPLY_THROTTLE_MS = 40;

interface UseAnnotationEditorProps {
  bookKey: string;
  annotation: BookNote;
  getAnnotationText: (range: Range) => Promise<string>;
  setSelection: React.Dispatch<React.SetStateAction<TextSelection | null>>;
}

export const useAnnotationEditor = ({
  bookKey,
  annotation,
  getAnnotationText,
  setSelection,
}: UseAnnotationEditorProps) => {
  const { envConfig } = useEnv();
  const { settings } = useSettingsStore();
  const { getConfig, saveConfig, updateBooknotes } = useBookDataStore();
  const { getView, getProgress, getViewsById, getViewSettings } = useReaderStore();

  const view = getView(bookKey);
  const editingAnnotationRef = useRef(annotation);
  const [handlePositions, setHandlePositions] = useState<HandlePositions | null>(null);

  // Cross-page drag state. The fixed (non-dragged) endpoint is anchored by
  // node/offset so it survives scrolling fully off-screen — mirroring the way
  // KOReader keeps the selection start as a stable xpointer while the page
  // temporarily becomes a scroll surface.
  const anchorRef = useRef<CaretPosition | null>(null);
  const anchorDocRef = useRef<Document | null>(null);
  const anchorIndexRef = useRef<number>(0);
  const dirRef = useRef<{ vertical: boolean; rtl: boolean }>({ vertical: false, rtl: false });
  const lastRangeRef = useRef<Range | null>(null);
  // When set, we transiently switched the paginated view to scroll flow and
  // must restore the original flow attribute on drag end.
  const restoreRef = useRef<{ flow: string | null } | null>(null);
  const switchingFlowRef = useRef(false);
  const autoScrollRef = useRef<{ raf: number; edge: ScrollEdge; point: Point } | null>(null);
  const lastApplyRef = useRef<number>(0);

  const getHandlePositionsFromRange = useCallback(
    (range: Range, isVertical: boolean): HandlePositions | null => {
      const gridFrame = document.querySelector(`#gridcell-${bookKey}`);
      if (!gridFrame) return null;

      const rects = Array.from(range.getClientRects());
      if (rects.length === 0) return null;

      const firstRect = rects[0]!;
      const lastRect = rects[rects.length - 1]!;
      const frameElement = range.commonAncestorContainer.ownerDocument?.defaultView?.frameElement;
      const frameRect = frameElement?.getBoundingClientRect() ?? { top: 0, left: 0 };

      return {
        start: {
          x: frameRect.left + (isVertical ? firstRect.right : firstRect.left),
          y: frameRect.top + firstRect.top,
        },
        end: {
          x: frameRect.left + (isVertical ? lastRect.left : lastRect.right),
          y: frameRect.top + lastRect.bottom,
        },
      };
    },
    [bookKey],
  );

  // Resolve a viewport point to a caret position inside the given section doc.
  // Returns null when the point is not over text in that document (e.g. it has
  // scrolled past the end of the section), which keeps the range from leaking
  // into an adjacent section/iframe (a CFI range can't span two sections).
  const resolveCaretInDoc = (doc: Document, x: number, y: number): CaretPosition | null => {
    const frameElement = doc.defaultView?.frameElement;
    const frameRect = frameElement?.getBoundingClientRect() ?? { top: 0, left: 0 };
    const adjustedX = x - frameRect.left;
    const adjustedY = y - frameRect.top;

    if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(adjustedX, adjustedY);
      if (pos) return { node: pos.offsetNode, offset: pos.offset };
    }
    if (doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(adjustedX, adjustedY);
      if (range) return { node: range.startContainer, offset: range.startOffset };
    }
    return null;
  };

  // Persist an updated range to the editing annotation: redraw the overlay in
  // every linked view, update the in-memory annotation, and on drag end commit
  // it to config and the selection popup.
  const persistRange = useCallback(
    async (newRange: Range, targetIndex: number, isDragging: boolean) => {
      if (!editingAnnotationRef.current || !view) return;

      const newPositions = getHandlePositionsFromRange(newRange, dirRef.current.vertical);
      if (newPositions) setHandlePositions(newPositions);

      const newCfi = view.getCFI(targetIndex, newRange);
      const newText = await getAnnotationText(newRange);
      if (!newCfi || !newText) return;

      const config = getConfig(bookKey)!;
      const progress = getProgress(bookKey)!;
      const { booknotes: annotations = [] } = config;
      const existingIndex = annotations.findIndex(
        (a) => a.id === editingAnnotationRef.current.id && !a.deletedAt,
      );
      if (existingIndex === -1) return;

      const existingAnnotation = annotations[existingIndex]!;
      const updatedAnnotation: BookNote = {
        ...existingAnnotation,
        cfi: newCfi,
        text: newText,
        updatedAt: Date.now(),
      };

      const views = getViewsById(bookKey.split('-')[0]!);
      views.forEach((v) => v?.addAnnotation(editingAnnotationRef.current, true));
      views.forEach((v) => v?.addAnnotation(updatedAnnotation));
      editingAnnotationRef.current = updatedAnnotation;
      lastRangeRef.current = newRange;

      if (!isDragging) {
        annotations[existingIndex] = updatedAnnotation;
        const updatedConfig = updateBooknotes(bookKey, annotations);
        if (updatedConfig) {
          saveConfig(envConfig, bookKey, updatedConfig, settings);
        }

        setSelection({
          key: bookKey,
          annotated: true,
          text: newText,
          cfi: newCfi,
          index: targetIndex,
          range: newRange,
          page: existingAnnotation.page || progress.page,
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bookKey, getHandlePositionsFromRange, getAnnotationText, setSelection],
  );

  const rebuildToPoint = useCallback(
    async (point: Point, isDragging: boolean) => {
      const doc = anchorDocRef.current;
      const anchor = anchorRef.current;
      if (!doc || !anchor || !view) return;

      const dragged = resolveCaretInDoc(doc, point.x, point.y);
      if (!dragged) return;

      const newRange = buildDirectedRange(doc, anchor, dragged);
      if (!newRange) return;

      await persistRange(newRange, anchorIndexRef.current, isDragging);
    },
    [view, persistRange],
  );

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRef.current) {
      cancelAnimationFrame(autoScrollRef.current.raf);
      autoScrollRef.current = null;
    }
  }, []);

  const autoScrollTick = useCallback(() => {
    const state = autoScrollRef.current;
    if (!state || !view) return;

    const dir = state.edge === 'end' ? 1 : -1;
    try {
      view.renderer.containerPosition += dir * AUTO_SCROLL_STEP;
    } catch {
      // ignore: renderer may be mid-relayout
    }

    const now = Date.now();
    if (now - lastApplyRef.current >= APPLY_THROTTLE_MS) {
      lastApplyRef.current = now;
      void rebuildToPoint(state.point, true);
    }

    state.raf = requestAnimationFrame(autoScrollTick);
  }, [view, rebuildToPoint]);

  const updateAutoScroll = useCallback(
    (edge: ScrollEdge, point: Point) => {
      if (!edge) {
        stopAutoScroll();
        return;
      }
      if (autoScrollRef.current) {
        autoScrollRef.current.edge = edge;
        autoScrollRef.current.point = point;
        return;
      }
      autoScrollRef.current = { raf: requestAnimationFrame(autoScrollTick), edge, point };
    },
    [autoScrollTick, stopAutoScroll],
  );

  // Lazily drop the paginated view to a continuous scroll surface the first
  // time a handle reaches an edge band, so the off-screen text on the next/prev
  // page becomes reachable. No-op when already in scroll mode.
  const ensureScrollFlow = useCallback(async () => {
    if (!view || restoreRef.current || switchingFlowRef.current) return;
    if (getViewSettings(bookKey)?.scrolled) return;

    switchingFlowRef.current = true;
    restoreRef.current = { flow: view.renderer.getAttribute('flow') };
    view.renderer.setAttribute('flow', 'scrolled');
    // Wait for the relayout (render() runs on the flow attribute change) so the
    // new scroll-mode geometry is in place before we hit-test again.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    switchingFlowRef.current = false;
  }, [view, bookKey, getViewSettings]);

  const beginRangeDrag = useCallback((handle: 'start' | 'end', range: Range, index: number) => {
    lastRangeRef.current = range;
    anchorIndexRef.current = index;
    const doc = range.commonAncestorContainer.ownerDocument ?? null;
    anchorDocRef.current = doc;
    anchorRef.current =
      handle === 'end'
        ? { node: range.startContainer, offset: range.startOffset }
        : { node: range.endContainer, offset: range.endOffset };

    let vertical = false;
    let rtl = false;
    if (doc?.defaultView && doc.body) {
      try {
        const cs = doc.defaultView.getComputedStyle(doc.body);
        vertical = cs.writingMode.startsWith('vertical');
        rtl = cs.writingMode === 'vertical-rl' || cs.direction === 'rtl' || doc.body.dir === 'rtl';
      } catch {
        // ignore: fall back to horizontal LTR defaults
      }
    }
    dirRef.current = { vertical, rtl };
    restoreRef.current = null;
  }, []);

  const dragRangeTo = useCallback(
    async (point: Point) => {
      if (!view) return;

      const gridFrame = document.querySelector(`#gridcell-${bookKey}`);
      const rect = gridFrame?.getBoundingClientRect();
      const edge = rect
        ? getAutoScrollEdge(
            point,
            { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
            { vertical: dirRef.current.vertical, rtl: dirRef.current.rtl, edgeSize: EDGE_BAND },
          )
        : null;

      if (edge) {
        await ensureScrollFlow();
        updateAutoScroll(edge, point);
      } else {
        stopAutoScroll();
      }

      await rebuildToPoint(point, true);
    },
    [view, bookKey, ensureScrollFlow, updateAutoScroll, stopAutoScroll, rebuildToPoint],
  );

  const endRangeDrag = useCallback(async () => {
    stopAutoScroll();

    const finalRange = lastRangeRef.current;
    if (finalRange) {
      await persistRange(finalRange, anchorIndexRef.current, false);
    }

    const restore = restoreRef.current;
    restoreRef.current = null;
    if (restore && view) {
      if (restore.flow == null) view.renderer.removeAttribute('flow');
      else view.renderer.setAttribute('flow', restore.flow);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      // Return to the highlight after restoring paginated flow.
      const cfi = editingAnnotationRef.current?.cfi;
      if (cfi) {
        try {
          await view.goTo(cfi);
        } catch {
          // ignore navigation errors
        }
      }
    }

    anchorRef.current = null;
    anchorDocRef.current = null;
  }, [view, persistRange, stopAutoScroll]);

  // Safety net: if the editor unmounts mid-drag, stop the auto-scroll loop and
  // restore the original (paginated) flow so the view isn't left in scroll mode.
  useEffect(() => {
    return () => {
      if (autoScrollRef.current) {
        cancelAnimationFrame(autoScrollRef.current.raf);
        autoScrollRef.current = null;
      }
      const restore = restoreRef.current;
      restoreRef.current = null;
      if (restore && view) {
        if (restore.flow == null) view.renderer.removeAttribute('flow');
        else view.renderer.setAttribute('flow', restore.flow);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    handlePositions,
    setHandlePositions,
    getHandlePositionsFromRange,
    beginRangeDrag,
    dragRangeTo,
    endRangeDrag,
  };
};
