export interface FileEntry {
  path: string;
  extension: string;
  bytes: number;
  lines: number;
  /** 正文 SHA-256 前 16 位；缺这个字段时出题键回落到全仓 `versionStamp` 语义。 */
  contentHash?: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: FileTreeNode[];
}

export interface Hotspot {
  path: string;
  changes: number;
}

/**
  文件在仓库里扮演的角色（架构层的粗分类）。只在「文件」这一粒度上取值：
  core = 执行主干；support = 支撑逻辑；infra = 外部设施接入（配置、存储、日志、网络客户端）；
  tool = 末端工具（无依赖也不被依赖）；test = 测试。
  口径由 `depgraph/roles.ts` 的结构规则给出（确定、可复现），不依赖模型。
*/
export type FileRole = "core" | "support" | "infra" | "tool" | "test";

export interface RepositoryIndex {
  repositoryId: string;
  repositoryPath: string;
  scannedAt: string;
  totalFiles: number;
  totalLines: number;
  files: FileEntry[];
  fileTree: FileTreeNode[];
  hotspots: Hotspot[];
  /**
    扫描期读不出来的文件（读到一半被删、权限不对、被换成特殊节点）。默认 = 一个都没有。
    这些文件被跳过而不算失败（一个坏文件不该掀掉整次导入），但必须记名：
    `totalFiles` 与后面所有「这个仓有多少代码、哪些文件没摘要」的读数都建立在「缺席是知道的」之上。
    上限 50 条，超出只按前 50 条报（够定位问题目录）。
  */
  unreadable?: UnreadableFile[];
}

/** 扫描期读不到的一个文件与其报错首行（原因要说得出口，不能只给「少了」）。 */
export interface UnreadableFile {
  path: string;
  reason: string;
}

export interface SourceAnchor {
  path: string;
  line: number;
  endLine?: number;
  label: string;
}
