// P1-T1：tree-sitter-python 节点四分类表（§3 不变量 7 的边界定义）。
//
// 四分类：
//   ① IR_MODELED          —— 已建模：映射进 IR，产出事实（清单为下限非上限：现状可解析集所需
//                            种类必须全部在此，含运算符族与基础字面量，发现 F）。
//   ② IGNORABLE_LEAF_NODES —— 可忽略：仅限「无子节点/无 fields 的叶子 token」（注释、标点、
//                            分隔符；M2‴：白名单叶子性由穷尽性测试机械判定）。
//   ③ PASSTHROUGH_NODES    —— 结构性穿透（壳）：自身不产事实、递归处理子节点；每条带
//                            justification；语义容器（字段名承载语义）禁入。
//   ④ 其余一律抛 IrCoverageError（适配器运行时强制；穷尽性测试保证本表 + ④ 集合 =
//      node-types.json 全部具体 named 种类）。
//
// ——— P1-T0 Golden 样本构造对号入座（每条样本的主构造 → 表内种类）———
//   a01/a03 print+字面量 → call/expression_statement/string/integer；a02/a48 binop+assign →
//   binary_operator/assignment；a04 字符串拼接 → binary_operator+string；a05 → true/false/none；
//   a06 → list/tuple；a09/a10 → pass_statement/comment；a12–a17 import/别名 → import_statement/
//   aliased_import/dotted_name；a18–a25 危险调用 → call/attribute；a26–a28 网络模块 →
//   import_statement+call；a29–a32/a43/a44 open → call/keyword_argument/binop/tuple；
//   a33–a38 链与重绑 → attribute/assignment；a39/a40 → call（b64decode/exec）；
//   a41 → assignment；a46 → keyword_argument；b04 f-string → string(f 前缀)/interpolation；
//   b19/b33 下标与链式比较 → subscript/comparison_operator；b22 三元 → conditional_expression；
//   b23 推导式 → list_comprehension/for_in_clause；b27/b29/b30 → delete/assert/raise_statement；
//   b01/b02 dict → dictionary/pair；b03 → f-string（适配器折叠 staticParts）；b05/b06 with →
//   with_statement/with_item；b07/b08 try → try_statement/except_clause/finally_clause；
//   b09/b10/b26 def/return → function_definition/return_statement/parameters/default_parameter；
//   b11/b12 class → class_definition/block；b13/b14 装饰器 → decorated_definition/decorator；
//   b15/b16 async → function_definition(isAsync)/await；b17/b18 lambda → lambda/
//   lambda_parameters；b20 下标赋值 → assignment+subscript；b21 切片 → subscript+slice；
//   b24 dict 推导 → dictionary_comprehension；b25 while → while_statement/augmented_assignment；
//   b28 global → global_statement；b31 set → set；b32 星号参数 → list_splat_pattern/
//   dictionary_splat_pattern；b35–b45 各包裹构造 → 同上对应种类。
//   「现状可解析集」（A 组）零 ④ 归类：上表对号无一条落 ④（禁净退化，§1.1-4）。
//
// ——— ③ 名称黑名单与语义容器禁入（发现 A，双护栏测试强制）———
//   名称匹配 /call|attribute|subscript|assign|import|await|yield|lambda|operator/ 的种类禁入 ③；
//   keyword_argument / slice / list_splat / dictionary_splat / named_expression 等语义容器
//   显式禁入 ③（它们以字段/位置承载 kwargs 归属等语义，scriptContentSecurity.ts 真实消费）。
export const IR_MODELED = new Set([
  // 模块与语句
  'module',
  'import_statement',
  'import_from_statement',
  'future_import_statement',
  'relative_import',
  'wildcard_import',
  'aliased_import',
  'dotted_name',
  'import_prefix',
  'expression_statement',
  'assignment',
  'augmented_assignment',
  'if_statement',
  'for_statement',
  'while_statement',
  'with_statement',
  'with_clause',
  'with_item',
  'try_statement',
  'except_clause',
  'finally_clause',
  'return_statement',
  'pass_statement',
  'break_statement',
  'continue_statement',
  'assert_statement',
  'raise_statement',
  'delete_statement',
  'global_statement',
  'nonlocal_statement',
  'function_definition',
  'class_definition',
  'decorator',
  // Python 2 遗留语句（罕见但 tree-sitter 可解析；建模为表达式语句保守递归）
  'print_statement',
  'exec_statement',
  'chevron',
  // 表达式
  'conditional_expression',
  'binary_operator',
  'comparison_operator',
  'boolean_operator',
  'unary_operator',
  'not_operator',
  'lambda',
  'call',
  'keyword_argument',
  'attribute',
  'subscript',
  'slice',
  'list',
  'tuple',
  'dictionary',
  'set',
  'pair',
  'list_splat',
  'dictionary_splat',
  'parenthesized_expression',
  'named_expression',
  'list_comprehension',
  'set_comprehension',
  'dictionary_comprehension',
  'generator_expression',
  'for_in_clause',
  'if_clause',
  'await',
  'yield',
  'ellipsis',
  'format_expression',
  'as_pattern',
  'as_pattern_target',
  'parenthesized_list_splat',
  'lambda_parameters',
  // 字面量与标识
  'identifier',
  'string',
  'concatenated_string',
  'interpolation',
  'integer',
  'float',
  'true',
  'false',
  'none',
  // 参数形态（function_definition / lambda 的参数项）
  'default_parameter',
  'typed_parameter',
  'typed_default_parameter',
  'list_splat_pattern',
  'dictionary_splat_pattern'
])

/** ② 可忽略叶子：判据 = node-types.json 中无 fields 且无 named children（叶子性机械可判定）。 */
export const IGNORABLE_LEAF_NODES = new Set([
  'comment', // 注释：无语义
  'escape_sequence', // string 内部转义：语义由父 string 整段 text 承载
  'escape_interpolation', // f-string 内 \{ \} 转义：语义由父 text 承载
  'type_conversion', // f-string !r 等转换标记：叶子 token，对安全语义无影响
  'string_start', // 引号开：无语义
  'string_end', // 引号闭：无语义
  'keyword_separator', // lambda 参数分隔符：
  'line_continuation', // 反斜杠续行：无语义（适配器取整段 text 时不依赖）
  'positional_separator' // 参数逗号：无语义
])

/**
 * ③ 结构性穿透（壳节点）：显式列名 + justification；自身不产事实、递归子节点。
 * 护栏测试（P1-T2）强制：名称黑名单 /call|attribute|subscript|assign|import|await|yield|lambda|operator/
 * 不命中；语义容器（keyword_argument/slice/list_splat/dictionary_splat/named_expression）不在本表。
 * 护栏性质声明：机械护栏只是防手滑，真正兜底是 P1-T5 Golden 比对与 P1-T2 IR 结构快照/穿透归属断言。
 */
export const PASSTHROUGH_JUSTIFICATIONS: Record<string, string> = {
  // 调用参数容器：无 fields；args/kwargs 归属由子节点自报（keyword_argument ① 承载 name 字段语义）
  argument_list: '壳：仅聚合调用参数；kwargs 归属由 ① keyword_argument 自身承载，穿透不改变分组（发现 A 断言覆盖）',
  // 函数/lambda 参数容器：无 fields；参数名由子节点 ① 产出
  parameters: '壳：仅聚合函数参数声明；默认值表达式随子节点递归',
  // 语句块：if/for/def/class 等的 body；子节点为语句序列按序递归
  block: '壳：语句序列容器；alternative 字段（elif/else_clause）同属语句容器，按 named children 顺序递归',
  // 复合语句的分支容器：递归其内部语句
  elif_clause: '壳：else-if 分支容器；test 表达式与 body 随子节点递归，归并逻辑在 if_statement ① 处理',
  else_clause: '壳：else 分支容器；body 随子节点递归',
  // 装饰器容器定义：@dec + 其下真实定义（function/class_definition ① 承载语义）
  decorated_definition: '壳：装饰器 + 定义体的外层包装；decorator 与定义随子节点递归',
  // 字符串容器内的内容段：文本语义由父 string 整段 text 承载（内容段递归到 interpolation ①）
  string_content: '壳：f-string/普通字符串内容段；其文本并入父节点处理，interpolation 子节点 ① 递归产出插值表达式',
  // 表达式/模式列表容器（raise 的 cause、match 的 pattern 列表等）：纯聚合
  expression_list: '壳：表达式序列聚合（罕见于安全语义），子节点逐个递归',
  // 单子节点类型容器（注解位置）：穿透其内部类型表达式；类型注解本身无执行语义
  type: '壳：类型注解容器，单 named 子节点穿透（generic_type/union_type 等若出现则落 ④ 抛错）',
  // f-string 格式说明容器（{value:{width}} 的 width 段）：内嵌表达式需递归（防插值逃逸）
  format_specifier: '壳：格式说明段容器；其内嵌表达式子节点递归分析，防插值表达式逃逸'
}
export const PASSTHROUGH_NODES = new Set(Object.keys(PASSTHROUGH_JUSTIFICATIONS))

/** 穷尽性测试用：本表应与 node-types.json 的全部「具体 named 种类」（去除 supertype）的差集为空。 */
export function isClassified(nodeType: string): boolean {
  return IR_MODELED.has(nodeType) || IGNORABLE_LEAF_NODES.has(nodeType) || PASSTHROUGH_NODES.has(nodeType)
}

/** ③ 名称黑名单（机械护栏 i）：命中者禁入 ③。 */
export const PASSTHROUGH_NAME_BLACKLIST = /call|attribute|subscript|assign|import|await|yield|lambda|operator/

/** ③ 语义容器禁入清单（机械护栏 ii，发现 A）。 */
export const SEMANTIC_CONTAINER_BAN = new Set([
  'keyword_argument',
  'slice',
  'list_splat',
  'dictionary_splat',
  'named_expression'
])

/**
 * ④ 显式文档化清单：合法语法但适配器**不建模**的构造，运行时遍历到即抛 IrCoverageError
 * （§3 不变量 1(c) → extraction-failed → 人工确认）。穷尽性测试断言：①∪②∪③∪④ = 全部
 * 具体 named 种类（与 node-types.json 同数据源）。
 * 现状可解析集（P1-T0 A 组）不涉及任何 ④ 种类（禁净退化）。
 */
export const EXPLICITLY_UNMODELED: Record<string, string> = {
  // struct/数据类 pattern 匹配（py3.10 match 语句族）：合法但不在支持面，显式抛错落人工
  match_statement: 'match 语句族未建模',
  case_clause: 'match 语句族未建模',
  case_pattern: 'match 语句族未建模',
  class_pattern: 'match 语句族未建模',
  complex_pattern: 'match 语句族未建模',
  dict_pattern: 'match 语句族未建模',
  keyword_pattern: 'match 语句族未建模',
  list_pattern: 'match 语句族未建模',
  pattern_list: 'match 语句族未建模',
  tuple_pattern: 'match 语句族未建模',
  union_pattern: 'match 语句族未建模',
  splat_pattern: 'match 语句族未建模',
  // 类型注解扩展形态（运行时无执行语义，但保守起见显式抛错而非穿透，防适配器静默吞构造）
  constrained_type: '类型注解扩展形态未建模',
  generic_type: '类型注解扩展形态未建模',
  member_type: '类型注解扩展形态未建模',
  splat_type: '类型注解扩展形态未建模',
  type_alias_statement: 'type 别名语句（py3.12）未建模',
  type_parameter: '类型参数（py3.12 泛型语法）未建模',
  union_type: '类型注解扩展形态未建模'
}
