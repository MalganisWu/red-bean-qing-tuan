# File Access 能力

跨文件类工具复用的机制层。这里不定义任何工具，只提供读取账本、路径策略、原子写入与共享上限，
让 `read-file`、`list-directory`、`glob`、`grep`、`write-file`、`edit-file`、`apply-patch` 表现一致。

```text
port/file-read-ledger.ts   按 conversation 记录「已读过哪份文件、读到哪个版本」的契约
read-ledger.ts             MemoryFileReadLedger：进程内参考实现
model/file-identity.ts     设备号 + inode，用于检测路径替换
path-policy.ts             固定根目录访问器（符号链接与身份复核），供 RootedReadTool 使用
atomic-write.ts            同目录临时文件 + fsync + rename
mutation-guard.ts          版本闸门：写入前要求同 conversation 已读且版本未变
ledger-key.ts              账本键的绝对化归一
literal-replace.ts         字面替换（避免 String.replace 的 $ 展开）
ordering.ts                跨 locale 稳定的名称排序
limits.ts                  发现类工具的默认输出上限
exclusions.ts              发现类工具默认排除的目录模式
```

## 读取账本为什么必须共享

「先读后写」要求写入类工具知道**当前 conversation 是否已读过该文件、读到的是哪个版本**。读取工具与
写入工具是各自独立的实例，所以账本由宿主在 composition root 创建一次并注入给双方；每个工具自建默认
实例会让闸门永远读不到读取记录，从而**静默失去保护**。写入类工具的构造函数因此把账本设为必填，
不给默认值——让漏接线在类型层面就暴露出来。

账本键按 conversation 与文件路径两层分桶。记录描述的是「这个 conversation 的上下文里有没有这份内容」，
不是文件的固有属性：只按路径记录会让另一个从未读过该文件的会话复用别人的读取结论。

## 版本粒度

账本记录 `mtimeMs`（毫秒），比展示层使用的秒级时间戳更细：秒级粒度会让同一秒内的外部改动被判定为
「未变更」，对只读只是少一次内容传输，对写入闸门却是真的漏判。

## 失败方向

路径无法确认、版本不一致、目标不是普通文件时一律拒绝写入，且拒绝发生在任何磁盘改动之前。
写入阶段的失败通过临时文件清理保证原文件不变——半写文件比写入失败更有害，因为模型会基于它继续判断。