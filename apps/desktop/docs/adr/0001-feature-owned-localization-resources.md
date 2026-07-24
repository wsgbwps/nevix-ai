# 翻译资源由各 Feature 分别拥有

Desktop 的各 Feature、应用壳和主进程分别拥有自身的简体中文与英文资源，共享本地化层只负责解析 Language Mode、协调 Interface Language 和提供翻译能力。相比集中式全局语言文件，这一边界延续了 Feature-Sliced 的物理隔离，避免翻译资源成为多人协作的修改热点，并使文案变更与所属功能保持在同一范围内。
