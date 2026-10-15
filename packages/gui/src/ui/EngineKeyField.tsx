import { useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import { KeyRound } from "lucide-react";
import { api } from "../api/client";
import { clearEngineKey, getEngineAuth, setEngineKey, subscribeEngineAuth } from "../api/engine-key";

/**
  引擎访问口令（认证闸门）。闸门关着时整个不渲染，不多一行看不懂的输入框——
  但**真实开机的引擎会先配发一张本机口令再开门**（`security/api-keys.ts` 的 `ensureLocalKey`，2026-10-15 拍板
  「本机调用也得带 token」），所以本机默认形态是「渲染」的：第一次连上要来这里粘一次口令。

  为什么是「启动先问一次 `/api/health`」而不是「等 401 再弹」：闸门一开，界面所有请求都 401，
  那时用户看到的是一堆「加载失败」，而不是「请先给口令」。健康检查这条免鉴权（它就是为探活存在的），
  所以能在第一次失败之前就问出闸门状态。真被 401 拒过时（口令错了或引擎换了 key），
  `unauthorized` 也会把它亮出来，不用刷新页面。

  `broken` 这一档要单独说话（三档口径见 `api.health` 的注释）：它**不是**「闸没开」，
  让用户去改口令是误导——要修的是引擎侧那个文件。
  存储口径与取舍（localStorage、§44）见 `api/engine-key.ts`，不在这里重复。
  */
export function EngineKeyField({ collapsed, onExpand }: { collapsed: boolean; onExpand: () => void }): ReactElement | null {
  const auth = useSyncExternalStore(subscribeEngineAuth, getEngineAuth, getEngineAuth);
  const [gate, setGate] = useState<"off" | "api-key" | "broken">("off");
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let alive = true;
    const probe = (): void => {
      void api.health().then((health) => { if (alive) setGate(health.auth ?? "off"); }).catch(() => { /* 连不上引擎时不猜闸门状态，保持原样 */ });
    };
    probe();
    window.addEventListener("online", probe);
    return () => { alive = false; window.removeEventListener("online", probe); };
  }, []);

  const explain = "这台引擎开了认证闸门：除健康检查外，所有接口都要带访问口令。本机那份是引擎首次开机自动配发的，取 ~/.codebase-tutor/api-keys.json 里 keys[0].key（文件 0600，日志与接口都不回显明文）。口令存在本浏览器的 localStorage，同源脚本可读——真边界在引擎那份文件与按仓授权，不在这里。";
  const brokenExplain = "引擎读不出或写不出自己的口令文件（api-keys.json：格式坏了、权限被改、写了口令却全都太短），现在按「拒绝全部」在跑。这边填什么都没用，要修的是引擎侧那份文件。";

  /** 换口令 = 整页重载一次：界面各处数据都是在挂载时取的，不重载就会停在「刚才那批 401」上。 */
  const commit = (value: string): void => {
    if (value.trim()) setEngineKey(value.trim());
    else clearEngineKey();
    window.location.reload();
  };

  if (gate === "broken") {
    // 只报状态、不给输入框：递一个注定无效的框，比不递更糟（用户会反复改口令）
    return (
      <div className="engine-key">
        <span className="nav-label">引擎口令文件坏了</span>
        <span className="nav-label" title={brokenExplain}>现在谁都不放行</span>
      </div>
    );
  }

  const gateOn = gate === "api-key";
  if (!gateOn && !auth.unauthorized && !auth.key) return null;
  if (collapsed) {
    // 收起态只留一枚钥匙：点它展开侧栏去填，而不是把输入框挤成 44px
    return (
      <button type="button" className={`engine-key-mini${auth.unauthorized ? " blocked" : ""}`} title={auth.unauthorized ? `口令不对或缺失 · ${explain}` : `引擎口令${auth.key ? "已配置" : "待填写"} · ${explain}`} onClick={onExpand} aria-label="引擎访问口令">
        <KeyRound size={14} />
      </button>
    );
  }

  return (
    <div className="engine-key">
      <span className="nav-label">{auth.unauthorized ? "口令被拒，请重填" : auth.key ? "引擎口令已配置" : "引擎需要口令"}</span>
      <div className="engine-key-row">
        <input
          type="password"
          value={draft}
          placeholder={auth.key ? "留空不改" : "访问口令"}
          aria-label="引擎访问口令"
          title={explain}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && draft.trim()) commit(draft.trim());
          }}
        />
        <button type="button" disabled={!draft.trim()} title="只存这台浏览器，不发给任何第三方；保存后页面会重载一次" onClick={() => commit(draft.trim())}>保存</button>
        {auth.key ? <button type="button" className="ghost" title="清掉后界面回到未鉴权状态（闸门开着就会全部 401）" onClick={() => commit("")}>清除</button> : null}
      </div>
    </div>
  );
}
