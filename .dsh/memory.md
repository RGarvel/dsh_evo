# dsh-reflect memory
<!-- managed by @garvel/dsh-reflect; one lesson per '- ' line, trailing #tags optional; never store secrets -->
- dsh_evo 工作区承载 dsh-reflect spike，进展与待办看 D:\dsh_evo\HANDOFF-NOTES.md #workspace
- 记忆文件实际路径：global 在 ~/.dsh/reflect/memory.md（队列 pending.md），workspace 在 <workspace>/.dsh/memory.md（队列 memory-pending.md）——不是 .dsh/reflect/ 子目录 #dsh-reflect #paths
- 早先那条「reflect_recall 只回 {scope,workspace_dir} 不回正文」是 render(args,value) 元数 bug 的症状，spike.2 已修，工具现在正常返回条目正文；遇到工具结果等于入参本身，先怀疑 render 而不是存储 #dsh-reflect #fixed
