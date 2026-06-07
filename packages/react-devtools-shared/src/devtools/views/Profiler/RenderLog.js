/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import * as React from 'react';
import {useContext} from 'react';
import Button from '../Button';
import useOpenResource from '../useOpenResource';
import RenderLogHtmlView from './RenderLogHtmlView';
import {
  RenderLogContext,
  RenderLogContextController,
  DEFAULT_MAX_ENTRIES,
  MAX_DEPTH,
} from './RenderLogContext';

import type {RenderLogItem} from './RenderLogContext';

import styles from './RenderLog.css';

// Options offered for the per-commit depth filter.
const DEPTH_OPTIONS = [1, 2, 3, 4, 6, 8];

// Options offered for the max-entries (buffer size) filter.
const MAX_ENTRIES_OPTIONS = [50, 100, 250, 500, 1000];

// How many indentation guides to draw at most, so deep chains never blow up
// the row width.
const MAX_INDENT_GUIDES = 8;

function DetailPanel({item}: {item: RenderLogItem}) {
  const {liveHTML, liveHTMLLoading} = useContext(RenderLogContext);
  const [canOpenSource, openSource] = useOpenResource(item.source, null);

  const html = item.htmlSnapshot != null ? item.htmlSnapshot : liveHTML;
  const htmlIsSnapshot = item.htmlSnapshot != null;

  return (
    <div className={styles.Detail}>
      <div className={styles.DetailHeader}>
        <span className={styles.DetailName}>{item.name}</span>
        <Button
          className={styles.DetailOpen}
          onClick={openSource}
          disabled={!canOpenSource}
          title={
            canOpenSource
              ? 'Abrir este componente no seu editor'
              : 'Localização do código indisponível (precisa de sourcemaps / build de dev)'
          }>
          {'<>'} Abrir no editor
        </Button>
      </div>

      {item.source != null && (
        <div className={styles.DetailSource}>
          {item.source[1]}:{item.source[2]}
        </div>
      )}

      <div className={styles.DetailSectionTitle}>Caminho</div>
      <div className={styles.DetailPath}>
        {!item.path || item.path.length === 0 ? (
          <span className={styles.DetailDim}>(raiz)</span>
        ) : (
          item.path.map((name, index) => (
            <span key={index}>
              <span className={styles.DetailPathItem}>{name}</span>
              {' › '}
            </span>
          ))
        )}
        <span className={styles.DetailPathCurrent}>{item.name}</span>
      </div>

      <div className={styles.DetailSectionTitle}>
        HTML{' '}
        <span className={styles.DetailDim}>
          {htmlIsSnapshot ? '(snapshot no momento do render)' : '(atual)'}
        </span>
      </div>
      <div className={styles.DetailHTML}>
        {liveHTMLLoading && !htmlIsSnapshot ? (
          <span className={styles.DetailDim}>Carregando…</span>
        ) : html != null ? (
          <RenderLogHtmlView html={html} />
        ) : (
          <span className={styles.DetailDim}>
            O elemento não está mais no DOM (pode ter sido desmontado).
          </span>
        )}
      </div>
    </div>
  );
}

function RenderLogContent() {
  const {
    items,
    totalCaptured,
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
  } = useContext(RenderLogContext);

  return (
    <div className={styles.RenderLog}>
      <div className={styles.Main}>
        <div className={styles.Toolbar}>
          <div
            className={`${styles.RecordingDot} ${
              isPaused ? styles.RecordingDotPaused : styles.RecordingDotActive
            }`}
          />
          <Button
            onClick={() => setIsPaused(!isPaused)}
            title={isPaused ? 'Retomar captura' : 'Pausar captura'}>
            {isPaused ? '▶ Retomar' : '⏸ Pausar'}
          </Button>
          <Button onClick={clear} title="Limpar o log de renders">
            Limpar
          </Button>
          <Button
            onClick={exportJSON}
            title="Exportar os nomes dos componentes logados como JSON">
            Exportar JSON
          </Button>

          <div className={styles.VRule} />

          <label
            className={styles.Checkbox}
            title="Mostrar apenas componentes definidos no seu código (fora de node_modules)">
            <input
              type="checkbox"
              checked={onlyUserCode}
              onChange={event => setOnlyUserCode(event.target.checked)}
            />
            Só meu código
          </label>

          <label
            className={styles.Checkbox}
            title="CUSTOSO: captura o HTML do elemento no momento exato de cada render. Use apenas quando precisar especificamente do HTML histórico — deixa a página mais lenta e usa mais memória. Quando desligado, clicar numa linha mostra o HTML ATUAL do elemento.">
            <input
              type="checkbox"
              checked={snapshotEnabled}
              onChange={event => setSnapshotEnabled(event.target.checked)}
            />
            Snapshot HTML ⚠️
          </label>

          <span className={styles.ToolbarLabel}>Profundidade</span>
          <select
            className={styles.Select}
            value={maxDepth === MAX_DEPTH ? 'all' : String(maxDepth)}
            onChange={event => {
              const value = event.target.value;
              setMaxDepth(value === 'all' ? MAX_DEPTH : parseInt(value, 10));
            }}>
            <option value="all">Todos os níveis</option>
            {DEPTH_OPTIONS.map(depth => (
              <option key={depth} value={String(depth)}>
                {depth} {depth === 1 ? 'nível' : 'níveis'}
              </option>
            ))}
          </select>

          <span className={styles.ToolbarLabel}>Limite</span>
          <select
            className={styles.Select}
            value={String(maxEntries)}
            onChange={event => {
              setMaxEntries(parseInt(event.target.value, 10));
            }}>
            {MAX_ENTRIES_OPTIONS.map(count => (
              <option key={count} value={String(count)}>
                {count}
              </option>
            ))}
          </select>

          <div className={styles.Spacer} />
          <span className={styles.ToolbarLabel}>
            {items.length} exibidos
            {onlyUserCode && totalCaptured > items.length
              ? ` de ${totalCaptured}`
              : ''}
          </span>
        </div>

        <div className={styles.Banner}>
          Stream ao vivo — o re-render mais recente fica no topo. Mantendo os
          últimos {maxEntries} re-renders. Clique numa linha para inspecionar.
          {snapshotEnabled && (
            <span className={styles.BannerWarn}>
              {' '}
              Snapshot HTML está LIGADO — custoso, desligue quando não precisar.
            </span>
          )}
        </div>

        {items.length === 0 ? (
          <div className={styles.Empty}>
            {isPaused
              ? 'Pausado. Aperte Retomar para voltar a capturar re-renders.'
              : onlyUserCode && totalCaptured > 0
                ? 'Nenhum re-render no seu código ainda. Componentes re-renderizaram, mas todos eram de node_modules. Desmarque “Só meu código” para vê-los.'
                : 'Aguardando re-renders… interaja com a página para ver os componentes renderizando aqui.'}
          </div>
        ) : (
          <div className={styles.List}>
            {items.map((item, index) => {
              const isCommitStart =
                index === 0 || items[index - 1].commitId !== item.commitId;
              const guideCount = Math.min(item.depth, MAX_INDENT_GUIDES);
              const overflow = item.depth - guideCount;
              const isSelected = item.key === selectedKey;
              return (
                <div
                  key={item.key}
                  className={`${styles.Row} ${
                    isCommitStart ? styles.RowCommitStart : ''
                  } ${isSelected ? styles.RowSelected : ''}`}
                  onClick={() => selectItem(item)}>
                  <span className={styles.Index}>{index + 1}</span>
                  <span className={styles.Name}>
                    {guideCount > 0 && (
                      <span className={styles.Guide}>
                        {'· '.repeat(guideCount)}
                      </span>
                    )}
                    {overflow > 0 && (
                      <span className={styles.Guide}>{`+${overflow} `}</span>
                    )}
                    <span
                      className={
                        item.isUserCode ? styles.NameUser : styles.NameLibrary
                      }>
                      {item.name}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedItem !== null && (
        <div className={styles.Sidebar}>
          <div className={styles.SidebarClose}>
            <Button onClick={() => selectItem(null)} title="Close details">
              ✕
            </Button>
          </div>
          <DetailPanel item={selectedItem} />
        </div>
      )}
    </div>
  );
}

export default function RenderLog(): React.Node {
  return (
    <RenderLogContextController>
      <RenderLogContent />
    </RenderLogContextController>
  );
}

export {DEFAULT_MAX_ENTRIES};
