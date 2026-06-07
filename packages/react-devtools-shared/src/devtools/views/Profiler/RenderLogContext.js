/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactContext, ReactFunctionLocation} from 'shared/ReactTypes';
import type {RenderLogCommit} from 'react-devtools-shared/src/backend/types';

import * as React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {BridgeContext, StoreContext} from '../context';

// Default cap on how many of the most recent re-renders we keep in memory.
export const DEFAULT_MAX_ENTRIES = 50;

// "Max depth" sentinel: when the depth filter equals this value, log everything.
export const MAX_DEPTH = Infinity;

// Incoming renders are coalesced and flushed to React state at most this often,
// so a page that renders at 60fps doesn't re-render the panel 60 times a second.
const FLUSH_INTERVAL_MS = 250;

// Raw captured entry. We keep everything and let the UI derive the visible /
// filtered list, so toggling filters re-applies to the whole history instantly.
type RawEntry = {
  key: number, // unique per log row (the same element re-renders many times)
  elementId: number, // DevTools element id (for highlight / inspect / live HTML)
  commitId: number,
  name: string,
  depthAbs: number,
  isUserCode: boolean,
  path: Array<string>,
  source: ReactFunctionLocation | null,
  htmlSnapshot: string | null,
  commitTime: number,
};

// One row as shown in the UI. `depth` here is already normalized for display
// (relative to the shallowest visible component of its commit).
export type RenderLogItem = {
  key: number,
  elementId: number,
  commitId: number,
  name: string,
  depth: number,
  isUserCode: boolean,
  path: Array<string>,
  source: ReactFunctionLocation | null,
  htmlSnapshot: string | null,
  commitTime: number,
};

export type Context = {
  // Already filtered + depth-normalized, most recent first.
  items: $ReadOnlyArray<RenderLogItem>,
  // How many raw entries are currently captured (before filtering).
  totalCaptured: number,
  isPaused: boolean,
  setIsPaused: (value: boolean) => void,
  clear: () => void,
  exportJSON: () => void,

  // Max number of entries to keep (the rest are dropped, oldest first).
  maxEntries: number,
  setMaxEntries: (value: number) => void,

  // Only show entries whose depth (relative to the shallowest visible component
  // of the commit) is within this many levels. Infinity = show all.
  maxDepth: number,
  setMaxDepth: (value: number) => void,

  // When true, only show components defined in user code (outside node_modules).
  onlyUserCode: boolean,
  setOnlyUserCode: (value: boolean) => void,

  // When true, the backend captures an outerHTML snapshot per render (EXPENSIVE).
  snapshotEnabled: boolean,
  setSnapshotEnabled: (value: boolean) => void,

  // Selection (the row whose details are shown in the side panel).
  selectedKey: number | null,
  selectItem: (item: RenderLogItem | null) => void,
  selectedItem: RenderLogItem | null,

  // Live HTML for the selected element (fetched on demand when no snapshot).
  liveHTML: string | null,
  liveHTMLLoading: boolean,

};

const RenderLogContext: ReactContext<Context> = createContext<Context>(
  ((null: any): Context),
);
RenderLogContext.displayName = 'RenderLogContext';

type Props = {
  children: React$Node,
};

function RenderLogContextController({children}: Props): React.Node {
  const bridge = useContext(BridgeContext);
  const store = useContext(StoreContext);

  // Raw captured entries, most recent first. Filters are applied at render time.
  const [rawEntries, setRawEntries] = useState<$ReadOnlyArray<RawEntry>>([]);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [maxEntries, setMaxEntries] = useState<number>(DEFAULT_MAX_ENTRIES);
  const [maxDepth, setMaxDepth] = useState<number>(MAX_DEPTH);
  const [onlyUserCode, setOnlyUserCode] = useState<boolean>(true);
  const [snapshotEnabled, setSnapshotEnabledState] = useState<boolean>(false);
  const [selectedKey, setSelectedKey] = useState<number | null>(null);
  const [liveHTML, setLiveHTML] = useState<string | null>(null);
  const [liveHTMLLoading, setLiveHTMLLoading] = useState<boolean>(false);

  // Mutable refs so the bridge listener always reads the latest values without
  // re-subscribing on every keystroke.
  const isPausedRef = useRef<boolean>(isPaused);
  const maxEntriesRef = useRef<number>(maxEntries);
  const nextKeyRef = useRef<number>(0);
  const nextCommitIdRef = useRef<number>(0);
  // The element id we're currently awaiting live HTML for (to ignore stale).
  const pendingHTMLElementIdRef = useRef<number | null>(null);
  // Coalescing buffer: incoming entries accumulate here and flush on a timer.
  const bufferRef = useRef<Array<RawEntry>>([]);
  const flushTimerRef = useRef<any>(null);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);
  useEffect(() => {
    maxEntriesRef.current = maxEntries;
  }, [maxEntries]);

  // Only capture in the backend while the tab is open AND not paused. Pausing
  // genuinely stops the backend work + bridge traffic (not just the UI), which
  // matters a lot when the page renders continuously (e.g. animations).
  useEffect(() => {
    bridge.send('setRenderLogEnabled', !isPaused);
  }, [bridge, isPaused]);

  // Turn everything off on unmount.
  useEffect(() => {
    return () => {
      bridge.send('setRenderLogEnabled', false);
      bridge.send('setRenderLogSnapshotEnabled', false);
    };
  }, [bridge]);

  const setSnapshotEnabled = useCallback(
    (value: boolean) => {
      setSnapshotEnabledState(value);
      bridge.send('setRenderLogSnapshotEnabled', value);
    },
    [bridge],
  );

  useEffect(() => {
    // Move the buffered entries into React state. Runs at most every
    // FLUSH_INTERVAL_MS regardless of how fast the page renders.
    const flush = () => {
      flushTimerRef.current = null;
      const buffered = bufferRef.current;
      if (buffered.length === 0) {
        return;
      }
      bufferRef.current = [];
      setRawEntries(prev => {
        const combined = buffered.concat(prev);
        const cap = maxEntriesRef.current;
        if (combined.length > cap) {
          combined.length = cap;
        }
        return combined;
      });
    };

    const onRenderLog = (commit: RenderLogCommit) => {
      if (isPausedRef.current) {
        return;
      }

      const entries = commit.entries;
      if (entries.length === 0) {
        return;
      }

      // Capture everything as-is. Depth normalization and filtering happen at
      // render time so the filters can be changed retroactively.
      const commitId = nextCommitIdRef.current++;
      const newEntries: Array<RawEntry> = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        newEntries.push({
          key: nextKeyRef.current++,
          elementId: typeof entry.id === 'number' ? entry.id : -1,
          commitId,
          name: entry.name,
          depthAbs: entry.depth,
          isUserCode: entry.isUserCode !== false,
          path: Array.isArray(entry.path) ? entry.path : [],
          source: entry.source != null ? entry.source : null,
          htmlSnapshot: entry.htmlSnapshot != null ? entry.htmlSnapshot : null,
          commitTime: commit.commitTime,
        });
      }

      // Prepend this commit (newest on top), cap the buffer, and schedule a
      // throttled flush instead of touching React state on every commit.
      const buf = newEntries.concat(bufferRef.current);
      const cap = maxEntriesRef.current;
      if (buf.length > cap) {
        buf.length = cap;
      }
      bufferRef.current = buf;
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(flush, FLUSH_INTERVAL_MS);
      }
    };

    bridge.addListener('renderLog', onRenderLog);
    return () => {
      bridge.removeListener('renderLog', onRenderLog);
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [bridge]);

  // Live HTML response handler.
  useEffect(() => {
    const onElementHTML = ({id, html}: {id: number, html: string | null}) => {
      if (pendingHTMLElementIdRef.current === id) {
        setLiveHTML(html);
        setLiveHTMLLoading(false);
      }
    };
    bridge.addListener('renderLogElementHTML', onElementHTML);
    return () => {
      bridge.removeListener('renderLogElementHTML', onElementHTML);
    };
  }, [bridge]);

  // Derive the visible list: apply the user-code filter, then normalize depth
  // per commit relative to the shallowest *visible* component, then apply the
  // depth limit. This keeps indentation small and meaningful.
  const items: $ReadOnlyArray<RenderLogItem> = useMemo(() => {
    const filtered = onlyUserCode
      ? rawEntries.filter(entry => entry.isUserCode)
      : rawEntries;

    // Find the shallowest absolute depth per commit (over visible entries).
    const minDepthByCommit: Map<number, number> = new Map();
    for (let i = 0; i < filtered.length; i++) {
      const entry = filtered[i];
      const current = minDepthByCommit.get(entry.commitId);
      if (current === undefined || entry.depthAbs < current) {
        minDepthByCommit.set(entry.commitId, entry.depthAbs);
      }
    }

    const result: Array<RenderLogItem> = [];
    for (let i = 0; i < filtered.length; i++) {
      const entry = filtered[i];
      const min = minDepthByCommit.get(entry.commitId) || 0;
      const depth = entry.depthAbs - min;
      if (maxDepth !== MAX_DEPTH && depth >= maxDepth) {
        continue;
      }
      result.push({
        key: entry.key,
        elementId: entry.elementId,
        commitId: entry.commitId,
        name: entry.name,
        depth,
        isUserCode: entry.isUserCode,
        path: entry.path,
        source: entry.source,
        htmlSnapshot: entry.htmlSnapshot,
        commitTime: entry.commitTime,
      });
    }
    return result;
  }, [rawEntries, onlyUserCode, maxDepth]);

  const selectedItem: RenderLogItem | null = useMemo(() => {
    if (selectedKey === null) {
      return null;
    }
    for (let i = 0; i < items.length; i++) {
      if (items[i].key === selectedKey) {
        return items[i];
      }
    }
    return null;
  }, [items, selectedKey]);

  const selectItem = useCallback(
    (item: RenderLogItem | null) => {
      if (item === null) {
        setSelectedKey(null);
        setLiveHTML(null);
        pendingHTMLElementIdRef.current = null;
        bridge.send('clearHostInstanceHighlight');
        return;
      }
      setSelectedKey(item.key);

      const rendererID = store.getRendererIDForElement(item.elementId);

      // Highlight the element on the page on click (an intentional, infrequent
      // action) instead of on hover — hover highlighting redraws the page
      // overlay constantly and janks an already-animating page.
      if (rendererID !== null) {
        bridge.send('highlightHostInstance', {
          id: item.elementId,
          rendererID,
          displayName: item.name,
          hideAfterTimeout: true,
          scrollIntoView: false,
          openBuiltinElementsPanel: false,
        });
      }

      // If there's a snapshot, the panel uses it directly. Otherwise fetch the
      // current HTML live from the backend.
      if (item.htmlSnapshot !== null) {
        setLiveHTML(null);
        pendingHTMLElementIdRef.current = null;
        return;
      }
      if (rendererID === null) {
        setLiveHTML(null);
        setLiveHTMLLoading(false);
        pendingHTMLElementIdRef.current = null;
        return;
      }
      pendingHTMLElementIdRef.current = item.elementId;
      setLiveHTML(null);
      setLiveHTMLLoading(true);
      bridge.send('getRenderLogElementHTML', {id: item.elementId, rendererID});
    },
    [bridge, store],
  );

  const clear = useCallback(() => {
    bufferRef.current = [];
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    setRawEntries([]);
    setSelectedKey(null);
    setLiveHTML(null);
  }, []);

  const exportJSON = useCallback(() => {
    // Simple JSON: just the component names, newest first (the visible list).
    const names = items.map(item => item.name);
    const json = JSON.stringify(names, null, 2);
    const blob = new Blob([json], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'react-render-log.json';
    if (document.body !== null) {
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    }
    URL.revokeObjectURL(url);
  }, [items]);

  const value = useMemo(
    () => ({
      items,
      totalCaptured: rawEntries.length,
      isPaused,
      setIsPaused,
      clear,
      exportJSON,
      maxEntries,
      setMaxEntries,
      maxDepth,
      setMaxDepth,
      onlyUserCode,
      setOnlyUserCode,
      snapshotEnabled,
      setSnapshotEnabled,
      selectedKey,
      selectItem,
      selectedItem,
      liveHTML,
      liveHTMLLoading,
    }),
    [
      items,
      rawEntries.length,
      isPaused,
      clear,
      exportJSON,
      maxEntries,
      maxDepth,
      onlyUserCode,
      snapshotEnabled,
      setSnapshotEnabled,
      selectedKey,
      selectItem,
      selectedItem,
      liveHTML,
      liveHTMLLoading,
    ],
  );

  return (
    <RenderLogContext.Provider value={value}>
      {children}
    </RenderLogContext.Provider>
  );
}

export {RenderLogContext, RenderLogContextController};
