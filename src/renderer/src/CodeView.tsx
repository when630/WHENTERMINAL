import { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { drawSelection, EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view'
import { bracketMatching, HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'

/** 문법 색: 테마마다 바뀌는 역할 토큰(--syn-*)만 쓴다 */
const style = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.heading], color: 'var(--syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--syn-fn)' },
  { tag: [t.attributeName, t.propertyName, t.labelName], color: 'var(--syn-attr)' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: 'var(--syn-comment)' },
  { tag: [t.punctuation, t.bracket, t.separator, t.operator], color: 'var(--gray)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, textDecoration: 'underline' },
  { tag: t.invalid, color: 'var(--signal-ink)' },
])

/** 앱 색 토큰을 따르는 모양 (테마를 바꾸면 같이 바뀐다) */
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--paper)', color: 'var(--ink)', fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '14px 0 24px', caretColor: 'var(--ink)' },
  '.cm-gutters': { backgroundColor: 'var(--paper)', color: 'var(--gray-2)', borderRight: 'var(--rule)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 16px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--ink) 18%, transparent) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--wash-2)' },
  '.cm-searchMatch': { backgroundColor: 'var(--wash-2)', outline: '1px solid var(--gray-2)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--sel-bg)', color: 'var(--sel-fg)' },
  '.cm-panels': { backgroundColor: 'var(--paper)', color: 'var(--ink)' },
  '.cm-panels.cm-panels-top': { borderBottom: 'var(--rule)' },
  '.cm-panel.cm-search': { padding: '6px 12px', fontFamily: 'var(--font)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { borderRadius: '0', fontFamily: 'var(--font)' },
  '.cm-textfield': { border: 'var(--rule)', background: 'var(--paper)', color: 'var(--ink)' },
  '.cm-button': { border: 'var(--rule)', backgroundImage: 'none', background: 'var(--paper)', color: 'var(--ink)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--wash-2)', outline: '1px solid var(--gray-2)' },
})

/**
 * 파일 원문 보기 (CodeMirror 6, 읽기 전용). 화면에 보이는 부분만 그려서 큰 파일도 가볍고,
 * 언어는 파일 이름으로 골라 그때 불러온다. 글을 고르거나 Ctrl+F로 찾을 수 있다.
 * 글이 뒤에 이어지면(나눠 읽기) 끝에 덧붙이기만 한다
 */
export function CodeView({ path, text }: { path: string; text: string }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const lang = useRef(new Compartment())

  // 파일이 바뀌면 새로 만든다
  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          // 앱의 전역 키 처리(Esc 실행 중단 등)가 이 칸의 키를 가져가지 않게
          EditorView.contentAttributes.of({ 'data-keys-own': 'true', 'aria-label': `${path} 원문` }),
          lineNumbers(),
          highlightSpecialChars(),
          drawSelection(),
          bracketMatching(),
          highlightSelectionMatches(),
          search({ top: true }),
          keymap.of(searchKeymap),
          syntaxHighlighting(style),
          lang.current.of([]),
          theme,
        ],
      }),
    })
    view.current = v
    let alive = true
    const desc = LanguageDescription.matchFilename(languages, path.slice(path.lastIndexOf('/') + 1))
    if (desc) {
      void desc.load().then((support) => {
        if (alive && view.current === v) v.dispatch({ effects: lang.current.reconfigure(support) })
      }, () => {})
    }
    return () => {
      alive = false
      v.destroy()
      view.current = null
    }
  }, [path]) // eslint-disable-line react-hooks/exhaustive-deps

  // 같은 파일의 글이 바뀌었다: 뒤에 이어 읽은 것이면 덧붙이고, 아니면 통째로 바꾼다
  useEffect(() => {
    const v = view.current
    if (!v) return
    const cur = v.state.doc
    if (cur.length === text.length && cur.toString() === text) return
    if (text.length > cur.length && text.startsWith(cur.sliceString(0, Math.min(cur.length, 4096))) && text.slice(0, cur.length) === cur.toString()) {
      v.dispatch({ changes: { from: cur.length, insert: text.slice(cur.length) } })
    } else {
      v.dispatch({ changes: { from: 0, to: cur.length, insert: text } })
    }
  }, [text])

  return <div className="fv-cm" ref={host} />
}
