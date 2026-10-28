/**
  ==== 语言能力表（引擎自报口径）====

  这是什么：每门语言 × 五个能力格的取值，只回答「引擎现在真的能做到什么程度」。
  为什么要单独成表：各语言的支持程度本来就不均——符号抽取走真实语法树（多语法，加载失败会回落逐行匹配），
  import 落点是每语言一条自己的规则（Java 全限定类名、Go 包目录、C# 命名空间、TS 相对路径 + 别名、
  Python 点号模块、C/C++ 头文件），入口判定只有部分语言有权威规则，构建清单只读了三份
  （package.json / tsconfig / go.mod）。这些差异只写在引擎代码里时，界面与读数都看不出来，
  用户拿到一张图没法判断「这条边是编译器级的、还是按文件名猜的」。

  四条纪律，违反任何一条就等于这张表在误导人：
  1. 它是引擎自报口径，与 `packages/engine/src/depgraph/graph.ts` + `parser.ts` 的实现必须同步：
     新增一门语言、补了某条规则，就改这张表；别在 GUI 或提示词里另写一份判断。
  2. 取值照实填，别因为「想让表好看」抬高某一个节点。判据见下面 `CapabilityLevel`。
  3. 纯元数据：不参与建图、不进任何缓存键（图的内容、`backendStamp`、摘要与润色缓存都与它无关），
     改这张表不会引发流程或摘要重算。真要挪走这份口径，先确认没有键把它算进去。
  4. 它跟 `DependencyGraphData.lspStatus` 是两套口径，别混用：本表说「引擎自己的规则有多硬」，
     `lspStatus` 说「有没有借到外部语义服务补类型与被引用次数」（目前只有 TypeScript 与 Python 会去探测）。
*/

/**
  三档的判据（写死在这里，避免引擎、界面、提示词各说一套）：
  - `exact` 可信：按这门语言/框架的权威规则落点，命中即可信。不足之处只会表现为「没覆盖到、少画一条」，
    而不是「画了一条错的」。
  - `approximate` 近似：规则在，但依据是启发式或粒度偏粗——同一条边可能多连几个文件，也可能落到同名文件上。
  - `unsupported` 未覆盖：没有针对这门语言的专门规则，只剩跨语言的通用兜底（按文件名猜），或这类文件根本不进图。

  未知语言一律回落 `unsupported`，不许按 `approximate` 装「大概能行」——近似必须显式。
*/
export type CapabilityLevel = "exact" | "approximate" | "unsupported";

/**
  九个能力格（GUI 与单测都按这份清单遍历，加格要一起改表与测试）：
  前五格说依赖图，后四格说静态产物层（`static_fact` 表，不参与任何缓存键）。
  - `symbolExtraction` 符号抽取：函数/类/方法是怎么被认出来的、起止行可不可信
  - `dependencyEdge` 依赖边落点：一条依赖边指向哪个文件，可信到什么程度
  - `entrypoint` 入口判定：图上标成「执行入口」的那个文件是怎么定的
  - `packageResolution` 路径别名与包解析：`@/x`、`crate::x`、`com.a.B` 这类非相对路径靠什么落点
  - `buildVisibility` 构建可见性：读不读这门语言的构建/清单文件，因而知不知道「哪些文件真在一起编译」
  - `controlFlow` 控制流图：函数内的分支、循环、跳转边编不编得出来
  - `dataflow` 函数内数据流：一个变量在哪行被定义、哪些行读到它
  - `typeRelations` 类型关系：继承/实现/字段/参数/返回值这些边，以及它们指到哪个文件
  - `registry` 注册与配置索引：路由、依赖注入绑定、SPI 清单、构建清单里的键
*/
export const CAPABILITY_CELLS = ["symbolExtraction", "dependencyEdge", "entrypoint", "packageResolution", "buildVisibility", "controlFlow", "dataflow", "typeRelations", "registry"] as const;

export type CapabilityCell = (typeof CAPABILITY_CELLS)[number];

export interface LanguageCapabilities {
  /** 语言 id，与本表的键一致；界面显示用 `displayName`，别直接露这个。 */
  language: string;
  displayName: string;
  /** 依赖图里归到这门语言的扩展名。各条目的这一列汇总成 `LANGUAGE_BY_EXTENSION`，不在别处再列一份。 */
  extensions: string[];
  /** 各格的取值；类型是必填的 `Record`，漏一个节点编译就过不去。 */
  cells: Record<CapabilityCell, CapabilityLevel>;
  /** 每个节点一句白话：说清「为什么是这一档」以及「看到这档该当怎么读」。界面提示条直接用它。 */
  notes: Record<CapabilityCell, string>;
}

/**
  表体。取值依据 = 当前实现（graph.ts 的分派 + parser.ts 的语法覆盖 + roles.ts 的测试路径判定），
  每一个节点都注了降级理由。改动实现后请同步这里，engine 侧有一份单测钉住「本表的扩展名清单
  与 `DependencyGraph` 实际处理的扩展名清单不漂移」。
  只用 `satisfies` 不用 `as const`：键的字面量类型留着（`SupportedLanguage` 靠它），
  但值里的 `extensions` 需要是可写数组，`as const` 会让它变成只读元组而通不过类型检查。
*/
export const LANGUAGE_CAPABILITIES = {
  typescript: {
    language: "typescript",
    displayName: "TypeScript / JavaScript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    cells: { symbolExtraction: "exact", dependencyEdge: "exact", entrypoint: "approximate", packageResolution: "approximate", buildVisibility: "approximate", controlFlow: "exact", dataflow: "approximate", typeRelations: "approximate", registry: "approximate" },
    notes: {
      symbolExtraction: "按真实语法树抽取函数、类、方法、接口与类型别名，起止行是解析出来的而不是按大括号数出来的。语法树整体加载失败时引擎会回落逐行匹配，并在图数据里写明回落原因。",
      dependencyEdge: "边来自真正的 import / export 语句，落点按「同名文件是否真在仓库里」逐个验证，而且只试这一门语言（含 Vue 与 TS 互引这一族）的扩展名——TS 里写 `./util` 不会连到同目录的 `util.py`。第三方包与解析不到的写法不会画出来，所以这里的少边是真少，不是连错。",
      entrypoint: "框架入口是精确的：Fastify / Express / Koa / Nest 的实例构造、路由登记与 listen 都算服务入口；客户端调用（axios 那种 api.get 一个路径）刻意不算，它是打路由的一方。证据行落在注释或跨行模板字符串里的也不算——这个节点判据取自语法树。剩下的靠 package.json 的 main / bin / scripts 与文件名（main、index、app、server、cli）猜：同名但并非入口的文件会被误标，实例从形参进来的子路由文件认不出来。",
      packageResolution: "只读仓库根那一份 tsconfig.json 的 paths，且只认带星号的通配别名（如 `@/*` → `src/*`）；精确别名、通过 extends 继承来的配置、包内的导出映射都不读，这类别名导入会画不出边。",
      buildVisibility: "读过根 package.json 与 tsconfig.json，但没有应用 include / exclude，也不看子包配置，所以图里的文件集合来自目录扫描，不受构建范围约束。",
      controlFlow: "if / 三元 / 循环（含 do-while 的先跑后判）/ switch（含无 break 的贯穿）/ try-catch-finally / return / throw / break / continue 全部按语法树编成节点与边，圈复杂度是「边数 − 节点数 + 2」算出来的而不是数分支数出来的。可选链与短路只用一条边近似表达先后，不逐子表达式分叉。",
      dataflow: "定义与读到按「名字」记：`a.x = 1` 记成对 `a` 的一次写，成员与解构不拆开；不做别名与指针分析，也不跨函数（谁传进来的参数在函数外被改，这里看不见）。多分支汇合处用并集，所以某行读到的定义是「可能到达」而不是「一定到达」。读不到本仓定义的名字进 `unresolved`，外部件与上游传值都混在这一格。",
      typeRelations: "边（继承 / 实现 / 字段 / 参数 / 返回值 / 泛型实参 / 类型别名）取自语法树，形状可信；但「这个类型定义在哪个文件」是按名字在全仓反查——同名类型会标成 `ambiguous`，第三方与标准库类型查不到落点（边留着，`toFile` 空着）。",
      registry: "认的是写法不是执行：`app.use(...)`、`router.get(\"/x\")`、Nest 的装饰器这类登记语句命中即入册，运行时未必真跑到。没覆盖的框架（自建路由表、插件按约定加载）只剩通用写法兜底；配置文件只进「键名」，值一律不抄（`.tutor` 目录是明文，抄口令就多一处泄露面）。"
    }
  },
  vue: {
    language: "vue",
    displayName: "Vue 组件",
    extensions: [".vue"],
    cells: { symbolExtraction: "approximate", dependencyEdge: "approximate", entrypoint: "unsupported", packageResolution: "approximate", buildVisibility: "unsupported", controlFlow: "approximate", dataflow: "approximate", typeRelations: "approximate", registry: "approximate" },
    notes: {
      symbolExtraction: "单文件组件没有专属语法：引擎把 `<script>` 块以外的行原地垫空，再按脚本语言解析。脚本里的函数与常量能拿到，模板与样式里的东西不进符号表。",
      dependencyEdge: "`<script>` 里的 import 走 TypeScript 那条规则，可信；但模板里 `<SomeButton />` 这类组件引用不会产生边，所以「这个页面用到那个组件」在图上看不见。",
      entrypoint: "没有针对 Vue 的入口规则。能标出来的入口来自 package.json 与 main.ts、App.vue 这类文件名约定，那是通用兜底。",
      packageResolution: "只认 tsconfig.json 里的通配别名；构建配置里另设的别名（如 vite / webpack 的别名表）不读，这类导入画不出边。",
      buildVisibility: "Vue 与构建器的配置文件一条都没读，因此不知道实际构建包含哪些文件、也没法把单文件组件拆成它的依赖。",
      controlFlow: "只编 `<script>` 里的那条路，用的还是 TypeScript 那套规则；模板里的 `v-if` / `v-for` / `v-show` 是组件真实分支的一部分，这里一条都不产生。看到单个组件的图只有脚本那半截，不是解析失败。",
      dataflow: "脚本块内部按名字记定义与读到（同 TypeScript 那格的限制：成员不拆开、不跨函数、汇合取并集）；模板里 `{{ count }}` 这类读法不算读到，所以 `count` 的读到点只列脚本里的那些。",
      typeRelations: "脚本里的 `interface` / `type` / class 继承与实现照收；`defineProps<{...}>()` 这种只有类型没有类名的形状不成边，模板里的组件用法更不在射程内。",
      registry: "`<script>` 里出现的 `app.use(插件)`、路由表登记这类通用写法会入册；但组件自身的名字、模板里的 `<router-view>` 与按目录约定的自动注册都不认，所以这个文件在册的条目通常比它实际登记的少。"
    }
  },
  python: {
    language: "python",
    displayName: "Python",
    extensions: [".py"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "approximate", packageResolution: "unsupported", buildVisibility: "unsupported", controlFlow: "approximate", dataflow: "approximate", typeRelations: "approximate", registry: "approximate" },
    notes: {
      symbolExtraction: "按真实语法树抽取函数与类，方法的归属靠缩进层级判定，起止行是解析出来的。语法树加载失败时回落逐行匹配（引擎会写明原因）。",
      dependencyEdge: "import 语句本身是真的，但 Python 的模块名是点号路径，落点要试文件：`from a.b import c` 会同时试 `a/b.py`、`a/b/__init__.py` 和 `a/b/c.py`——同名目录或文件会连错；标准库与第三方包按设计不入图。仓库不是「根目录就是包根」的布局（例如代码在 `src/` 下）时，绝对导入落不到点。",
      entrypoint: "认的是框架级语句而不是文件名：应用对象（`app = FastAPI(...)`）、Django 的路由表、挂在应用对象上的路由装饰器、启动语句，以及脚本守卫 `if __name__ == \"__main__\":`——命中即取代按文件名猜，且一个文件只取最强的一条。没覆盖到的（其它 Web 框架、命令行工具的入口声明）只剩文件名约定兜底；装饰器那一条理论上会把同名的其它装饰器误认成路由。",
      packageResolution: "不读任何包配置（pyproject.toml、setup.cfg、requirements.txt），没有源码根布局与命名空间包的概念。",
      buildVisibility: "打包与依赖清单一条都没读，因此分不清包内代码与 vendored 依赖，也不知道哪些文件真属于同一个分发单元。",
      controlFlow: "if / elif 链（含缩进里的 `else if`）/ for / while / try-except-else-finally / return / raise / break / continue 都按语法树编边；`with` 当作直接穿过的壳。两处形状还没进表：3.10 的 `match/case` 会被摊平成普通语句（图上看着像没有分支），`for/while ... else` 的 else 体不收。看到这两类文件的图比实际短，是这一格造成的，不是解析失败。",
      dataflow: "按名字记定义与读到：`self.count = 1` 记成对 `self` 的写，成员不拆开；不解推导式与生成器表达式的内部变量作用域，也不跨函数。多分支汇合取并集，读不到本仓定义的名字进 `unresolved`（内置函数、第三方对象全在这一格）。",
      typeRelations: "类头的基类与函数签名上的标注照收；Python 的类型是可选的，没写标注的地方一条边也不会有——这里的少边是「源码本身没说」，不是「引擎丢了」。基类落点按名字在全仓反查，同名会标 `ambiguous`，标准库基类没有落点。",
      registry: "`@app.route` / `urlpatterns` / Blueprint 登记这类写法命中即入册；用装饰器变量、循环批量注册或第三方框架自有的登记形状认不出来。pyproject 与 requirements 只进「键名与包名」，值不抄。"
    }
  },
  java: {
    language: "java",
    displayName: "Java",
    extensions: [".java"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "approximate", packageResolution: "approximate", buildVisibility: "unsupported", controlFlow: "exact", dataflow: "approximate", typeRelations: "approximate", registry: "approximate" },
    notes: {
      symbolExtraction: "按真实语法树抽取类、方法、构造器、接口、枚举与记录，起止行是解析出来的。",
      dependencyEdge: "三条路：① 直接 import（`import com.a.B;`）按「包名 + 文件名」定位，通常可信；② `import com.a.*;` 这种整包导入只在类名真的出现在正文（含注释）里时才补一条边，强度低于直接 import；③ 类型派发边——类头 `extends`/`implements` 的落点（接口与实现之间没有调用行，靠它把实现类接回执行流）。跨文件调用边认「类名.方法(」与「变量接收者」：`mapper.insert(` 靠字段、方法参数、局部变量三种声明形状换成类型，换不出就退回裸名匹配。注释与 import 行在扫描前清除（等长替换，行号不变），注释里写的 `xxxService.handle(...)` 不算调用证据。同名类型、继承来的方法、内部类的归属仍可能指错，所以整格是 approximate。",
      entrypoint: "Spring 仓可信：启动类与控制器上的框架注解是权威标记，路由前缀能直接报出来。但非 Spring 的 Java 仓目前没有规则（连 `public static void main` 都还没进主函数清单），只剩文件名约定兜底。",
      packageResolution: "全限定类名靠每个文件自己的 package 声明来定，这条可信；但同名类型的取舍、内部类与静态成员的精确归属靠逐级去尾试探，不做模块级区分。",
      buildVisibility: "不读 Maven / Gradle 构建文件：分不清主代码目录与测试目录的构建范围，生成的源码目录也被当成普通源码进图。",
      controlFlow: "if / else、三种 for（含 for-each）、while / do-while、switch（冒号贯穿与箭头形式都认）、try-catch-finally 与带资源的 try、return / throw / break / continue 全按语法树编边。唯一没区分的一处：`break 标签` / `continue 标签` 目前按最内层那层循环接，所以标签跳多层循环的函数会少一段路。",
      dataflow: "按名字记定义与读到：`user.getName()` 里的 `user` 算读、`this.count = 1` 算对 `this` 的写，成员与字段不拆开；不做别名分析、不跨方法（接口方法在哪实现、实现里改了什么，这里看不见）。汇合点取并集，读不到本仓定义的名字进 `unresolved`——getter 拿到的、依赖注入框架塞进来的都落在这一格，数量大是正常的。",
      typeRelations: "类头的 `extends` / `implements`、字段类型、方法参数与返回值、泛型实参都成边，形状来自语法树；落点按简单类名在全仓反查，同名类型标 `ambiguous`，JDK 与第三方类型没有落点（边留着、`toFile` 空着）。接口与实现之间靠这张表才连得上——它比依赖图那条派发边细，但同样是名字反查。",
      registry: "Spring 这条线覆盖得最全：`@Autowired` / `@Resource` 字段注入与构造器注入落成「接口 → 实现」的绑定，`@RestController` / `@RequestMapping` 的路由、`@Bean` 工厂方法、`@ComponentScan` 这类扫描开关、`META-INF/services` 的 SPI 实现清单都入册。认的是写法不是执行：没被扫到的包里的注解一样进册。application.yml / .properties 只进「键名」，值一律不抄（`.tutor` 是明文目录，抄了口令就多一处泄露面）。非 Spring 仓只剩通用写法兜底。"
    }
  },
  go: {
    language: "go",
    displayName: "Go",
    extensions: [".go"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "exact", packageResolution: "approximate", buildVisibility: "approximate", controlFlow: "exact", dataflow: "approximate", typeRelations: "approximate", registry: "approximate" },
    notes: {
      symbolExtraction: "按真实语法树抽取函数、方法和类型（结构体 / 接口的名字在类型声明里单独展开）。",
      dependencyEdge: "Go 的 import 指向「包」（一个目录）而不是文件，落点会把该目录下所有非测试文件各连一条边——粒度是整个包，比真正用到的那几个文件宽。对不上仓内模块前缀的（外部仓库、被替换的依赖）不画。",
      entrypoint: "`func main()` 是语言级的唯一起点，命中即确定；每个可执行文件一个，测试文件已排除。",
      packageResolution: "读每个 go.mod 的 module 行来划仓内边界，这块可信；替换指令、多模块工作区文件与 vendored 目录不认，这类路径落不到点。",
      buildVisibility: "读过 go.mod（模块名），但不读工作区与 vendor 清单，也不按构建标签取舍文件，所以图里的文件集合按目录扫描，不随构建条件变化。",
      controlFlow: "if / else if 链、唯一的 `for`（三种形态，`for {}` 死循环不接出口）、`switch`（含表达式式与类型式，只有写 `fallthrough` 才掉下去）、`select` 的每个通信臂、`goto` 与标签（向前跳也接得上）、return / break / continue 都按语法树编边。`defer` 是普通语句，不会画到函数出口那一格——它的执行时机在图上体现不出来。`break 标签` 同 Java 那格：按最内层循环接。",
      dataflow: "按名字记定义与读到：`:=` 短变量声明、普通赋值、`i++`、形参都算定义；`s.field = x` 记成对 `s` 的写，成员不拆开。`err := f()` 这种多返回值只按左边的名字记，不看返回了第几个值；不跨函数，汇合取并集。读不到定义的名字进 `unresolved`，包外的函数与内置的 `len` 之类全在这一格。",
      typeRelations: "结构体字段类型、接口的内嵌、方法的接收者类型、函数参数与返回值、泛型实参都成边。Go 没有继承，`extends` 这一类只会出现在接口内嵌上；接口的实现关系是隐式的（没有 `implements` 字样），所以「谁实现了这个接口」在这张表里连不出来，得靠调用边反推。落点按名字在全仓反查，同名标 `ambiguous`。",
      registry: "路由登记按写法收：`r.GET(\"/x\", h)`、`mux.Handle`、`http.HandleFunc` 这类命中即入册，`/path` 里的 `{}` 与 `:` 段折成 `{*}` 后比对。Go 没有依赖注入容器规则，`fx.Module` / wire / 手写构造函数注入都不认（这类关系要从类型关系与调用边里看）。go.mod 只进模块路径这一条，版本号与 require 的值不抄。"
    }
  },
  rust: {
    language: "rust",
    displayName: "Rust",
    extensions: [".rs"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "exact", packageResolution: "approximate", buildVisibility: "unsupported", controlFlow: "approximate", dataflow: "approximate", typeRelations: "approximate", registry: "approximate" },
    notes: {
      symbolExtraction: "按真实语法树抽取函数、结构体、trait、枚举与模块；impl 块里的函数升为方法。",
      dependencyEdge: "两种仓内关系都认：`mod x;`（子模块声明，落 `x.rs` 或 `x/mod.rs`，与编译器一致）和 `use crate::a::b;`。后者会一段段去掉尾部往上找能落地的文件，所以 `use crate::a::b::Thing` 常连到 a 的模块文件而不是 Thing 真正定义的文件——方向对、位置偏粗。属性里指定的非常规文件名不认。",
      entrypoint: "`fn main()` 是语言级起点，命中即确定。库工程没有 main 是正常情况，不算入口缺失。",
      packageResolution: "`crate::` 的起点按约定假定为 `src/`，`mod` 声明相对当前文件解析（这两条覆盖标准布局）；但不读 Cargo.toml，`[lib]`/`[[bin]]` 指定的自定义入口落不到点。",
      buildVisibility: "Cargo.toml 没读：工作区成员、测试与基准目录的构建边界、按功能开关取舍的代码都判不出来。",
      controlFlow: "if / else if 链、`loop` / `while` / `for`、match 的每一臂（含 `_` 兜底与 `if` 守卫）、`?` 的「提前离开 / 继续」两条边（藏在 `let v = f()?;` 里的也扫得到）、return 与闭包都按语法树编。两处把它压到近似：`break '外层标签` / `continue '外层标签`（Rust 的常见写法）目前按最内层那层接，边指错而不是缺失；`panic!`、`unreachable!` 这类宏当普通语句，不会画出「这里离开函数」。",
      dataflow: "按名字记定义与读到：`let`（含 `let mut`）、赋值、`+=` 这类复合赋值、形参算定义；`let (a, b) = …` 的解构只按整条声明记，成员与字段不拆开。移动与借用是 Rust 的核心语义，这里不跟踪——值被移走之后原来的名字仍按「读得到」算。汇合取并集，不跨函数；读不到定义的名字进 `unresolved`。",
      typeRelations: "`impl Trait for Type` 的两头都成边（这是 Rust 唯一能连「接口 ↔ 实现」的地方）、`impl` 块里的自类型、结构体与枚举的字段类型、函数参数与返回、泛型实参都收；trait bound（`T: Display`）与关联类型不展开。落点按名字在全仓反查，同名标 `ambiguous`，标准库与 crate 外的类型没有落点。",
      registry: "认的是链式登记的写法：`.route(\"/x\", …)`、`.layer(…)`、`.nest(…)` 命中即入册。但 Actix / Rocket 的主力写法是属性宏（`#[get(\"/x\")]`、`#[derive(...)]`），宏展开不是这套语法树能看到的，这类路由在注册索引里是空的——要找回它们得看类型关系与调用边。Cargo.toml 只收段名（`[lib]` / `[workspace]`）与 `name =` 的目标名，依赖版本不抄。"
    }
  },
  csharp: {
    language: "csharp",
    displayName: "C#",
    extensions: [".cs"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "approximate", packageResolution: "unsupported", buildVisibility: "unsupported", controlFlow: "exact", dataflow: "approximate", typeRelations: "approximate", registry: "approximate" },
    notes: {
      symbolExtraction: "按真实语法树抽取类、结构体、接口、枚举与方法。",
      dependencyEdge: "`using A.B.C;` 指向命名空间而非文件，落点是「声明了这个命名空间的全部文件」，比真正用到的类宽。命名空间靠正文里的 namespace 语句收（块式与文件式都收）；跨项目引用（类型在另一个工程里）落不到点。",
      entrypoint: "`Main` / `MainAsync` 方法名命中即可信；但新版允许的顶层语句（入口文件直接写代码、不声明 Main）认不出来，这类仓只能退回文件名约定。",
      packageResolution: "不读工程文件与解决方案文件：没有项目引用的概念，全仓按命名空间字符串混在一起找落点。",
      buildVisibility: "工程文件没读：目标框架、按条件编译取舍的代码、被排除的文件都判不出来，生成物目录只在目录排除规则生效时才不进图。",
      controlFlow: "if / else、for（三种头）/ foreach / while / do、switch（C# 不贯穿，所以每臂一条到结尾的边）、try-catch-finally（含只 catch 或只有 finally 的形状）、`using` / `lock` / `checked` 这类不改路径的壳按直接穿过处理、return / throw / break / continue 与 goto + 标签都按语法树编边。`break 标签` 同 Java：按最内层接；switch 里的 `goto case` / `goto default` 认成接不上的标签，会在该函数的 `notes` 里点名，不静默略过。",
      dataflow: "按名字记定义与读到：声明（含 `var`）、赋值、`+=` 复合赋值、`out` / `ref` 实参、形参都算定义；`user.Name = x` 记成对 `user` 的写，属性与字段不拆开。不跨方法调用（`service.Save(list)` 里对 list 做了什么看不见），汇合取并集。读不到本仓定义的名字进 `unresolved`，BCL 类型与扩展方法全落在这一格。",
      typeRelations: "类头的基类与接口列表、字段类型、方法参数与返回值、泛型实参、`where T : …` 约束都成边；属性（`public Foo Bar { get; set; }`）的 `Foo` 暂时不收，这类关系要去调用边那边看。落点按名字在全仓反查，同名标 `ambiguous`，BCL 与 NuGet 里的类型没有落点。",
      registry: "依赖注入这条线覆盖到位：`AddScoped<接口, 实现>()` / `AddSingleton` / `AddTransient`（含 Keyed 那三种与 `AddScoped<I>(sp => …)` 的工厂写法）都落成「接口 → 实现」的绑定；工程文件收 `ProjectReference` / `PackageReference` 的项目名、解决方案收项目清单。路由不在射程内：`[Route(\"api/x\")]` 特性与最小 API 的 `app.MapGet(…)` 都不认，那是 Java / Python 那条路由规则没扩到这里。配置文件只进键名，值一律不抄。"
    }
  },
  cpp: {
    language: "cpp",
    displayName: "C / C++",
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "exact", packageResolution: "unsupported", buildVisibility: "unsupported", controlFlow: "exact", dataflow: "approximate", typeRelations: "approximate", registry: "unsupported" },
    notes: {
      symbolExtraction: "按真实语法树抽取（C 与 C++ 共用一份语法）。C 的函数名不在独立字段里，要从声明符链条末端取，实现已覆盖指针与引用修饰。",
      dependencyEdge: "只认引号形式的 `#include \"x.h\"`（项目内头文件），尖括号是系统或第三方头，按设计不入图。先按当前文件同目录解析（编译器的首要规则）；解析不到就退化成「全仓里路径以这个名字结尾的文件」，多个命中就全连——这些是按文件名猜的边。头文件搜索路径（编译时指定的包含目录）无从得知。",
      entrypoint: "`int main(` 是语言级起点，命中即确定。",
      packageResolution: "没有包管理器清单可查，引擎也没读：包含目录、库依赖关系都不判。",
      buildVisibility: "构建脚本（CMake / Bazel / makefile）一条都没读：编译单元怎么划分、宏定义了哪些分支、按条件取舍的文件都判不出来。",
      controlFlow: "if / else、for（含区间 for）、while / do-while、switch（C/C++ 默认贯穿，没写 break 就掉下一臂）、goto + 标签（向前跳先记账、建完再连）、try / catch（C++，一个 catch 既是处理器也是兜底）、return / throw / break / continue 都按语法树编边。两处不建模：`throw` 之后经过的局部对象析构不画展开路径；`setjmp` / 信号 / 协程这类非常规跳转当普通调用。",
      dataflow: "按名字记定义与读到：声明、初始化、赋值、`++` / `--`、复合赋值、形参都算定义。指针与引用不做别名分析——`*p = x` 记成对 `p` 的写，`p` 指向的那个对象在图上不认；`free(p)` 之后再用 `p` 也照旧算「读得到」。这就是 C/C++ 里这一格只能是近似的原因。汇合取并集，不跨函数；读不到的名字进 `unresolved`（库函数、宏展开出来的全在这一格）。",
      typeRelations: "类的基类列表（含 `public` / `virtual` 修饰后的那个名字）、结构体与类的成员、函数参数与返回、模板实参、`using X = Y` 的别名都成边；前置声明（`class Foo;`）也收到，可能只有一条指向自己的名字。落点按名字在全仓反查——头文件声明、源文件实现是两份同名，会标成 `ambiguous`；标准库类型没有落点。",
      registry: "这一格没有规则：注册与配置索引靠的是框架写法（路由登记、依赖注入绑定）或构建清单，C/C++ 两边都没接——既没有可注册的框架概念，也不读 CMakeLists / Bazel / makefile。所以本门语言的源码与构建脚本在注册索引里一条都不会有，读侧看到的空白是真空白。"
    }
  }
} satisfies Record<string, LanguageCapabilities>;

/** 本表覆盖的语言 id（`languageCapabilitiesOf` 对未知语言回落的条目不在此列）。 */
export type SupportedLanguage = keyof typeof LANGUAGE_CAPABILITIES;

/** 各格全为 `unsupported` 的回落条目：未知语言用它，界面会明说「这门语言没有规则」。 */
export const UNKNOWN_LANGUAGE_CAPABILITIES: LanguageCapabilities = {
  language: "unknown",
  displayName: "未知语言",
  extensions: [],
  cells: { symbolExtraction: "unsupported", dependencyEdge: "unsupported", entrypoint: "unsupported", packageResolution: "unsupported", buildVisibility: "unsupported", controlFlow: "unsupported", dataflow: "unsupported", typeRelations: "unsupported", registry: "unsupported" },
  notes: {
    symbolExtraction: "引擎没有这门语言的语法，文件里的函数与类进不了符号表。",
    dependencyEdge: "引擎没有这门语言的依赖解析规则，图里不会出现它指向别人或别人指向它的边。",
    entrypoint: "没有入口规则，只有跨语言的文件名约定可能把它误认成入口。",
    packageResolution: "非相对路径无处可查，落不了点。",
    buildVisibility: "构建清单不读，实际编译范围未知。",
    controlFlow: "没有语法就没有控制流图：这个文件在产物层不留行，读侧看到的是「没算过」而不是「算出来是空的」。",
    dataflow: "同上，变量在哪行定义、哪些行读到，一条也记不出来。",
    typeRelations: "类型之间的边要从语法树里读，没有语法就没有边。",
    registry: "既没有这一门的注册写法表，也没有它的构建清单键表，所以路由、注入绑定、配置键都无从登记。"
  }
};

/**
  扩展名 → 语言。由本表各条目的 `extensions` 汇总而成（只有一份来源）。
  ⚠️ 与 `DependencyGraph` 实际处理的扩展名同一条命：加一门语言要改两处，漂移由 engine 的单测发现。
*/
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, SupportedLanguage>> = Object.fromEntries(
  Object.entries(LANGUAGE_CAPABILITIES).flatMap(([language, entry]) => entry.extensions.map((extension): [string, SupportedLanguage] => [extension, language as SupportedLanguage]))
);

/** 只认自有键：`Object.fromEntries` 出来的对象仍带原型，`"constructor"` 这类键不能被判成一门语言。 */
const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/** 一个扩展名（`.java`）或文件名属于哪门语言；图里没有这个扩展名时 undefined。 */
export function languageOfExtension(extension: string): SupportedLanguage | undefined {
  const normalized = (extension ?? "").trim().toLowerCase();
  if (!normalized) return undefined;
  const key = normalized.startsWith(".") ? normalized : `.${normalized}`;
  return hasOwn(LANGUAGE_BY_EXTENSION, key) ? LANGUAGE_BY_EXTENSION[key] : undefined;
}

/**
  查一门语言的能力档：接受语言 id（`java`）、扩展名（`.java` 或 `java`）或带扩展名的路径（`src/a.java`）。
  未知语言回落 `UNKNOWN_LANGUAGE_CAPABILITIES`（全格 `unsupported`），不假装是 approximate。
*/
export function languageCapabilitiesOf(extensionOrLanguage: string): LanguageCapabilities {
  const raw = (extensionOrLanguage ?? "").trim().toLowerCase();
  if (!raw) return UNKNOWN_LANGUAGE_CAPABILITIES;
  const slash = raw.lastIndexOf("/");
  const tail = slash >= 0 ? raw.slice(slash + 1) : raw;
  if (hasOwn(LANGUAGE_CAPABILITIES, tail)) return LANGUAGE_CAPABILITIES[tail as SupportedLanguage];
  const dot = tail.lastIndexOf(".");
  const language = dot > 0 ? languageOfExtension(tail.slice(dot)) : languageOfExtension(tail);
  return language ? LANGUAGE_CAPABILITIES[language] : UNKNOWN_LANGUAGE_CAPABILITIES;
}
