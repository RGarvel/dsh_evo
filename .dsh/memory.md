# dsh-reflect memory
<!-- managed by @garvel/dsh-reflect; one lesson per '- ' line, trailing #tags optional; never store secrets -->
- dsh_evo 工作区承载 dsh-reflect spike，进展与待办看 D:\dsh_evo\HANDOFF-NOTES.md #workspace
- 记忆文件实际路径：global 在 ~/.dsh/reflect/memory.md（队列 pending.md），workspace 在 <workspace>/.dsh/memory.md（队列 memory-pending.md）——不是 .dsh/reflect/ 子目录 #dsh-reflect #paths
- 早先那条「reflect_recall 只回 {scope,workspace_dir} 不回正文」是 render(args,value) 元数 bug 的症状，spike.2 已修，工具现在正常返回条目正文；遇到工具结果等于入参本身，先怀疑 render 而不是存储 #dsh-reflect #fixed
- dsh-reflect 上游三贴已发为 discussion #5510(Ideas 主线)/#5511(General 文档 render 第二参)/#5512(General bug oneOf 参数被字符串化)；#4879 是作者自己的「Web GUI 侧边栏视图切换 seam」讨论(dsh-channel-view)，与 dsh-reflect 无关、早前张冠李戴已纠正。PowerShell 用 gh discussion create 时标题内嵌双引号会被拆参（unknown argument "0"），标题里的引号要拿掉；gh 查 GraphQL 传 --field 会被 PowerShell -f/引号干扰，改用 curl --data @file 稳 #dsh-reflect #github #powershell
