import {useEffect, useRef, type ReactElement } from "react";
import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import type { ExerciseLanguage } from "@codebase-tutor/domain";

// 练习页代码编辑器：CodeMirror 6，只装高亮与基础交互。
// 判分只认沙箱测试，编辑器不带 lint / 补全 / 语法检查。
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
