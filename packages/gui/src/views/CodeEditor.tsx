import { useEffect, useRef, type ReactElement } from "react";
import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import type { ExerciseLanguage } from "@codebase-tutor/shared";

/**
  练习页的代码编辑器（刀 3）：CodeMirror 6，只装高亮与基础交互，**不装 lint / 补全 / 语法检查**。
  为什么不装：那几档要么需要一个跑在浏览器里的编译器（类型检查要整份项目图），要么会给出与判分不一致的
  「看起来对」——判分只认沙箱里那组测试（见 engine `exercises/code-generate.ts`）。界面里多一个绿色波浪线，
  学习者会以为那是判据。
  外壳是 `.code-editor`（源码岛那套深底）叠 `.ans-editor`（原型答题框的最小高度与留白）——两档都取同一组
  `--code-*` 令牌，所以不需要为「答题区」另写一份 CSS。
*/
export interface CodeEditorFile {
  path: string;
  contents: string;
}

function languageExtension(path: string, declared: ExerciseLanguage) {
  // 以文件名为准、语言档兜底：python 的文件后缀是 .py，java 是 .java，TS 系是 .ts/.js（沙箱里 .ts 直接跑）
  if (path.endsWith(".py")) return python();
  if (path.endsWith(".java")) return java();
  if (path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".js") || path.endsWith(".jsx")) return javascript({ typescript: path.endsWith(".ts") || path.endsWith(".tsx") });
  return declared === "python" ? python() : declared === "java" ? java() : javascript({ typescript: true });
}

export function CodeEditor({ file, language, resetKey, ariaLabel, onChange }: { file: CodeEditorFile; language: ExerciseLanguage; resetKey: string; ariaLabel: string; onChange: (contents: string) => void }): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  // onChange 走 ref：编辑器只在换题/换文件时重建，键入过程中不该因为父组件重渲染被拆掉重装（那会丢光标与撤销栈）
  const emit = useRef(onChange);
  emit.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      state: EditorState.create({
        // 这里的 file.contents 只在重建那一次读（初始文档），所以它**不在依赖里**：
        // 加进去就等于每次键入都把编辑器拆了重装，光标跳到开头。resetKey 才是「换了一道题」的信号。
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
    // 卸载要 destroy：CodeMirror 往 document 上挂了键盘与剪贴板的被动监听，不拆就是每次换题漏一对
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- file.contents 是初始值，故意不跟手
  }, [resetKey, file.path, language]);

  return <div className="code-editor ans-editor" ref={host} data-testid="code-editor" aria-label={ariaLabel} />;
}
