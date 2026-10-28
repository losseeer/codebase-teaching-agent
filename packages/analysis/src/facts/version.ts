/**
  静态产物层的判据版本：`static_fact` 按文件存，仓被驱逐后挂回来读的是盘上旧行。
  读侧按版本区分「当前判据下确实没有」与「判据改了但还没重算」。
*/
export const FACTS_VERSION = "facts-v2";

