import {useEffect, useRef, type ReactElement } from "react";
import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import type { ExerciseLanguage } from "@codebase-tutor/domain";

// 练习页代码编辑器：CodeMirror 6，只装高亮与基础交互。
// 判分只认沙箱测试，编辑器不带 lint / 补全 / 语法检查。
/** 深色源码岛主题与语法色：全取 `--code-*` / `--hl-*`，与 SourceView 同一套 token。 */
const islandTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--code-ink)", fontSize: "var(--fs-12)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.62" },
  ".cm-content": { caretColor: "var(--code-accent)", padding: "10px 0" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--code-ink-2)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--code-hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--code-ink)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--code-accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--code-highlight)" },
  ".cm-selectionMatch, .cm-matchingBracket": { backgroundColor: "var(--code-highlight)" },
  ".cm-matchingBracket": { color: "var(--code-ink)" }
}, { dark: true });

const islandHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "var(--hl-kw)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--hl-str)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--hl-cm)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--hl-num)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--hl-fn)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--hl-type)" },
  { tag: [t.propertyName, t.attributeName, t.definition(t.variableName)], color: "var(--hl-prop)" },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator, t.derefOperator], color: "var(--hl-op)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--hl-tag)" },
  { tag: t.invalid, color: "var(--danger)" }
]);

export interface CodeEditorFile {
  path: string;
  contents: string;
}

function languageExtension(path: string, declared: ExerciseLanguage) {
  // 文件名优先，声明语言为辅
  if (path.endsWith(".py")) return python();
  if (path.endsWith(".java")) return java();
  if (path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".js") || path.endsWith(".jsx")) return javascript({ typescript: path.endsWith(".ts") || path.endsWith(".tsx") });
  return declared === "python" ? python() : declared === "java" ? java() : javascript({ typescript: true });
}

export function CodeEditor({ file, language, resetKey, ariaLabel, onChange }: { file: CodeEditorFile; language: ExerciseLanguage; resetKey: string; ariaLabel: string; onChange: (contents: string) => void }): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  // onChange 走 ref：键入过程中不重建编辑器，避免丢光标与撤销栈
  const emit = useRef(onChange);
  emit.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: file.contents,
        extensions: [
          basicSetup,
          islandTheme,
          syntaxHighlighting(islandHighlight),
          languageExtension(file.path, language),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) emit.current(update.state.doc.toString());
          })
        ]
      }),
      parent: host.current
    });
    // 卸载必须 destroy：CodeMirror 挂在 document 上的监听要一并解除
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- file.contents 只作初始文档读一次，换题信号是 resetKey
  }, [resetKey, file.path, language]);

  return <div className="code-editor ans-editor" ref={host} data-testid="code-editor" aria-label={ariaLabel} />;
}
