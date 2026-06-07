/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import * as React from 'react';
import {useMemo} from 'react';

import styles from './RenderLog.css';

// How many levels of nesting to expand before collapsing deeper children.
const MAX_HTML_DEPTH = 2;

// Elements that never have children / closing tags.
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

type Attr = [string, string | null];
type Token =
  | {type: 'open', name: string, attrs: Array<Attr>, selfClosing: boolean}
  | {type: 'close', name: string}
  | {type: 'text', value: string}
  | {type: 'comment', value: string};

type ElementNode = {
  type: 'element',
  name: string,
  attrs: Array<Attr>,
  children: Array<Node>,
};
type TextNode = {type: 'text', value: string};
type CommentNode = {type: 'comment', value: string};
type Node = ElementNode | TextNode | CommentNode;

function parseTag(s: string): {name: string, attrs: Array<Attr>} {
  const trimmed = s.trim();
  const nameMatch = trimmed.match(/^[a-zA-Z0-9:-]+/);
  const name = nameMatch ? nameMatch[0] : trimmed;
  const rest = trimmed.slice(name.length);
  const attrs: Array<Attr> = [];
  const attrRe = /([^\s=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s]+))?/g;
  let m;
  while ((m = attrRe.exec(rest)) !== null) {
    const key = m[1];
    let val = null;
    if (m[2] !== undefined) {
      if (m[3] !== undefined) {
        val = m[3];
      } else if (m[4] !== undefined) {
        val = m[4];
      } else {
        val = m[2];
      }
    }
    attrs.push([key, val]);
  }
  return {name, attrs};
}

function tokenize(html: string): Array<Token> {
  const tokens: Array<Token> = [];
  let i = 0;
  const len = html.length;
  while (i < len) {
    if (html[i] === '<') {
      if (html.startsWith('<!--', i)) {
        const end = html.indexOf('-->', i + 4);
        const stop = end === -1 ? len : end + 3;
        tokens.push({type: 'comment', value: html.slice(i, stop)});
        i = stop;
      } else if (html[i + 1] === '/') {
        const end = html.indexOf('>', i);
        const stop = end === -1 ? len : end + 1;
        const name = html.slice(i + 2, end === -1 ? len : end).trim();
        tokens.push({type: 'close', name});
        i = stop;
      } else {
        const end = html.indexOf('>', i);
        const stop = end === -1 ? len : end + 1;
        const inner = html.slice(i + 1, end === -1 ? len : end);
        const selfClosing = inner.endsWith('/');
        const cleaned = selfClosing ? inner.slice(0, -1) : inner;
        const {name, attrs} = parseTag(cleaned);
        tokens.push({type: 'open', name, attrs, selfClosing});
        i = stop;
      }
    } else {
      const next = html.indexOf('<', i);
      const stop = next === -1 ? len : next;
      tokens.push({type: 'text', value: html.slice(i, stop)});
      i = stop;
    }
  }
  return tokens;
}

function buildTree(tokens: Array<Token>): ElementNode {
  const root: ElementNode = {
    type: 'element',
    name: '#root',
    attrs: [],
    children: [],
  };
  const stack: Array<ElementNode> = [root];
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    const parent = stack[stack.length - 1];
    if (tok.type === 'text') {
      const value = tok.value.replace(/\s+/g, ' ').trim();
      if (value !== '') {
        parent.children.push({type: 'text', value});
      }
    } else if (tok.type === 'comment') {
      parent.children.push({type: 'comment', value: tok.value});
    } else if (tok.type === 'open') {
      const node: ElementNode = {
        type: 'element',
        name: tok.name,
        attrs: tok.attrs,
        children: [],
      };
      parent.children.push(node);
      if (!tok.selfClosing && !VOID_ELEMENTS.has(tok.name.toLowerCase())) {
        stack.push(node);
      }
    } else if (tok.type === 'close') {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name.toLowerCase() === tok.name.toLowerCase()) {
          stack.length = k;
          break;
        }
      }
    }
  }
  return root;
}

function OpenTag({node, isVoid}: {node: ElementNode, isVoid: boolean}) {
  return (
    <span>
      <span className={styles.HtmlPunct}>{'<'}</span>
      <span className={styles.HtmlTag}>{node.name}</span>
      {node.attrs.map((attr, i) => (
        <span key={i}>
          {' '}
          <span className={styles.HtmlAttrName}>{attr[0]}</span>
          {attr[1] !== null && (
            <React.Fragment>
              <span className={styles.HtmlPunct}>=</span>
              <span className={styles.HtmlAttrValue}>"{attr[1]}"</span>
            </React.Fragment>
          )}
        </span>
      ))}
      <span className={styles.HtmlPunct}>{isVoid ? ' />' : '>'}</span>
    </span>
  );
}

function CloseTag({node}: {node: ElementNode}) {
  return (
    <span>
      <span className={styles.HtmlPunct}>{'</'}</span>
      <span className={styles.HtmlTag}>{node.name}</span>
      <span className={styles.HtmlPunct}>{'>'}</span>
    </span>
  );
}

function indentOf(depth: number): string {
  return '  '.repeat(depth);
}

function renderNode(node: Node, depth: number, key: string): React.Node {
  if (node.type === 'text') {
    return (
      <div key={key} className={styles.HtmlLine}>
        {indentOf(depth)}
        <span className={styles.HtmlText}>{node.value}</span>
      </div>
    );
  }
  if (node.type === 'comment') {
    return (
      <div key={key} className={styles.HtmlLine}>
        {indentOf(depth)}
        <span className={styles.HtmlComment}>{node.value}</span>
      </div>
    );
  }

  const isVoid =
    VOID_ELEMENTS.has(node.name.toLowerCase()) || node.children.length === 0;

  // Leaf or void element: single line, no closing tag needed for void.
  if (node.children.length === 0) {
    return (
      <div key={key} className={styles.HtmlLine}>
        {indentOf(depth)}
        <OpenTag node={node} isVoid={isVoid} />
        {!isVoid && <CloseTag node={node} />}
      </div>
    );
  }

  // Single text child: keep inline (e.g. <span>Hello</span>).
  if (node.children.length === 1 && node.children[0].type === 'text') {
    return (
      <div key={key} className={styles.HtmlLine}>
        {indentOf(depth)}
        <OpenTag node={node} isVoid={false} />
        <span className={styles.HtmlText}>{node.children[0].value}</span>
        <CloseTag node={node} />
      </div>
    );
  }

  // Beyond the max depth, collapse children behind an ellipsis.
  if (depth >= MAX_HTML_DEPTH) {
    return (
      <div key={key} className={styles.HtmlLine}>
        {indentOf(depth)}
        <OpenTag node={node} isVoid={false} />
        <span className={styles.HtmlEllipsis}>…</span>
        <CloseTag node={node} />
      </div>
    );
  }

  // Block element: open tag, children indented, close tag.
  return (
    <React.Fragment key={key}>
      <div className={styles.HtmlLine}>
        {indentOf(depth)}
        <OpenTag node={node} isVoid={false} />
      </div>
      {node.children.map((child, i) =>
        renderNode(child, depth + 1, `${key}-${i}`),
      )}
      <div className={styles.HtmlLine}>
        {indentOf(depth)}
        <CloseTag node={node} />
      </div>
    </React.Fragment>
  );
}

export default function RenderLogHtmlView({html}: {html: string}): React.Node {
  // Parsing + element construction is O(html length); only redo it when the
  // HTML actually changes (not on every parent re-render).
  const content = useMemo(() => {
    const root = buildTree(tokenize(html));
    return root.children.map((child, i) => renderNode(child, 0, `n-${i}`));
  }, [html]);
  return <div className={styles.HtmlView}>{content}</div>;
}
