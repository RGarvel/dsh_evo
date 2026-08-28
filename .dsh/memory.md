# dsh-reflect memory
<!-- managed by @garvel/dsh-reflect; one lesson per '- ' line, trailing #tags optional; never store secrets -->
- dsh_evo 工作区记忆文件首条：本工作区承载 dsh-reflect spike，进展看 D:\dsh_evo\HANDOFF-NOTES.md #workspace
- reflect_recall 的返回只含 {scope,workspace_dir}、不回条目正文，判断某作用域是否为空必须直接读文件：global 在 ~/.dsh/reflect/memory.md，workspace 在 <workspace>/.dsh/memory.md（不是 .dsh/reflect/） #dsh-reflect #pitfall
- reflect_consolidate 是整文件重写，剔除单条前先读盘、把要保留的旧条目原文一并传回 #dsh-reflect
