import { useEffect, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, drawSelection, rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { unifiedMergeView } from '@codemirror/merge';
import { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { yaml } from '@codemirror/lang-yaml';

const SHOAL_HIGHLIGHT = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.moduleKeyword], color: '#c39ad6' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName], color: '#84a9dd' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#74bdc4' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: '#9cc28a' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#e3c17a' },
  { tag: [tags.propertyName, tags.attributeName], color: '#a1bfe8' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#6b6f78', fontStyle: 'italic' },
  { tag: [tags.heading], color: '#f3f4f6', fontWeight: '600' },
  { tag: [tags.strong], fontWeight: '600' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: '#84a9dd', textDecoration: 'underline' },
  { tag: [tags.invalid], color: '#e07a73' },
]);

const SHOAL_THEME = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--term)',
    color: '#e6e8ec',
    fontSize: '0.8125rem',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: '"Maple Mono NF CN", "Cascadia Mono", Consolas, "Microsoft YaHei Mono", monospace',
    lineHeight: '1.5',
  },
  '.cm-content': {
    padding: '0.5rem 0',
    caretColor: '#dcdfe4',
  },
  '.cm-line': {
    padding: '0 0.75rem',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#dcdfe4',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: '#34445e !important',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--term)',
    color: '#6b6f78',
    borderRight: '1px solid var(--line)',
    userSelect: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: '#b6b9c1',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--raised)',
    border: '1px solid var(--line-2)',
    color: 'var(--text-2)',
    padding: '0 0.375rem',
    borderRadius: '0.25rem',
  },
  '.cm-panels': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    borderBottom: '1px solid var(--line)',
  },
  '.cm-search': {
    padding: '0.375rem 0.625rem',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.375rem',
    fontSize: '0.75rem',
  },
  '.cm-textfield': {
    backgroundColor: 'var(--bg)',
    border: '1px solid var(--line-2)',
    borderRadius: '0.25rem',
    color: 'var(--text)',
    padding: '0.1875rem 0.4375rem',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--raised)',
    border: '1px solid var(--line-2)',
    borderRadius: '0.25rem',
    color: 'var(--text-2)',
    padding: '0.125rem 0.5rem',
    cursor: 'pointer',
  },
  // Unified diff styling
  '.cm-changedLine': {
    backgroundColor: 'rgba(156, 194, 138, 0.12)',
  },
  '.cm-changedText': {
    backgroundColor: 'rgba(156, 194, 138, 0.28)',
  },
  '.cm-deletedChunk': {
    backgroundColor: 'rgba(224, 122, 115, 0.12)',
    padding: '0 0.75rem',
  },
  '.cm-deletedChunk .cm-deletedText': {
    backgroundColor: 'rgba(224, 122, 115, 0.28)',
  },
  '.cm-collapsedLines': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text-3)',
    padding: '0.25rem 0.75rem',
    borderTop: '1px solid var(--line)',
    borderBottom: '1px solid var(--line)',
    cursor: 'pointer',
    fontSize: '0.75rem',
  },
}, { dark: true });

function languageForPath(filePath: string): Extension | null {
  const lower = filePath.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.'));
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return javascript({ typescript: true });
    case '.tsx':
      return javascript({ typescript: true, jsx: true });
    case '.js':
    case '.mjs':
    case '.cjs':
      return javascript();
    case '.jsx':
      return javascript({ jsx: true });
    case '.json':
    case '.jsonc':
    case '.jsonl':
      return json();
    case '.css':
    case '.scss':
    case '.less':
      return css();
    case '.html':
    case '.htm':
    case '.svg':
    case '.xml':
      return html();
    case '.md':
    case '.mdx':
      return markdown();
    case '.py':
      return python();
    case '.rs':
      return rust();
    case '.yml':
    case '.yaml':
      return yaml();
    default:
      return null;
  }
}

export interface JumpTarget {
  line: number;
  col?: number;
  seq: number;
}

export interface CodeEditorProps {
  docKey: string; // changes when switching files or switching diff <-> edit mode
  filePath: string;
  value: string;
  baseValue?: string; // provided when mode === 'diff'
  mode: 'edit' | 'diff';
  readOnly?: boolean;
  externalRev?: number; // increments when clean content is hot-reloaded from disk
  jump?: JumpTarget | null;
  onChange?: (next: string) => void;
  onSave?: () => void;
}

export function CodeEditor({
  docKey, filePath, value, baseValue = '', mode, readOnly = false, externalRev = 0, jump, onChange, onSave,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacksRef = useRef({ onChange, onSave });
  callbacksRef.current = { onChange, onSave };
  const suppressChangeRef = useRef(false);

  // Recreate EditorState cleanly whenever docKey (file / mode / baseValue in diff) changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const lang = languageForPath(filePath);
    const isReadOnly = readOnly || mode === 'diff';
    const extensions: Extension[] = [
      lineNumbers(),
      highlightSpecialChars(),
      drawSelection(),
      rectangularSelection(),
      bracketMatching(),
      foldGutter(),
      search({ top: true }),
      highlightSelectionMatches(),
      SHOAL_THEME,
      syntaxHighlighting(SHOAL_HIGHLIGHT),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            callbacksRef.current.onSave?.();
            return true;
          },
        },
        ...searchKeymap,
        ...foldKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
    ];

    if (lang) extensions.push(lang);

    if (mode === 'diff') {
      extensions.push(
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        unifiedMergeView({
          original: baseValue,
          highlightChanges: true,
          gutter: true,
          syntaxHighlightDeletions: true,
          mergeControls: false,
          collapseUnchanged: { margin: 3, minSize: 4 },
        }),
      );
    } else {
      extensions.push(
        history(),
        indentOnInput(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
      );
      if (isReadOnly) {
        extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
      } else {
        extensions.push(
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !suppressChangeRef.current) {
              callbacksRef.current.onChange?.(u.state.doc.toString());
            }
          }),
        );
      }
    }

    const state = EditorState.create({ doc: value, extensions });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // Intentionally keyed on docKey (+ baseValue when in diff mode) so typing never recreates the editor
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, mode === 'diff' ? baseValue : '', readOnly]);

  // Apply external silent reload in edit mode while preserving scroll/cursor where possible.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || mode !== 'edit') return;
    const current = view.state.doc.toString();
    if (current === value) return;
    suppressChangeRef.current = true;
    try {
      const head = Math.min(view.state.selection.main.head, value.length);
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        selection: { anchor: head },
      });
    } finally {
      suppressChangeRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalRev]);

  // Jump to requested line:col when triggered from terminal link or search.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jump) return;
    const lineNum = Math.max(1, Math.min(jump.line, view.state.doc.lines));
    const lineInfo = view.state.doc.line(lineNum);
    const colOffset = jump.col ? Math.max(0, Math.min(jump.col - 1, lineInfo.length)) : 0;
    const pos = lineInfo.from + colOffset;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    if (mode === 'edit' && !readOnly) view.focus();
  }, [jump, docKey, mode, readOnly]);

  return <div className="cm-host" ref={hostRef} data-testid="code-editor" data-mode={mode} />;
}
