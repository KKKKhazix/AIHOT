# CONTEXT.md — KernelHOT 术语决议

> 本文档记录 Linux 内核热点站（KernelHOT）领域设计中的术语决议，供后续实施阶段参考。

---

## 术语表

| 术语 | 英文 | 说明 |
|---|---|---|
| 主线内核 | mainline kernel | 由 Linus Torvalds 维护的内核树，包含最新功能开发 |
| LTS | Long-Term Support kernel | 长期支持内核版本，由特定维护者维护 |
| RC | Release Candidate | 内核候选版本，用于最终测试 |
| 合并窗口 | merge window | Linus 定期开放的主线合并期，约 2 周 |
| stable | stable kernel | Greg Kroah-Hartman 维护的稳定内核树，接收 bug 修复 |
| linux-next | linux-next | 预合并树，测试各子树之间的兼容性 |
| Lore | lore.kernel.org | LKML 邮件列表的网页归档 |
| LKML | Linux Kernel Mailing List | 内核开发主要邮件列表 |
| CVE | Common Vulnerabilities and Exposures | 通用漏洞披露编号 |
| RCF | Responsible Careers Framework | 内核社区责任框架（人员管理指南） |
| 子系统 | subsystem | 内核的子树模块，如网络、文件系统、内存管理等 |
| 驱动 | driver | 硬件驱动程序，如 GPU 驱动、网络驱动等 |
| 发行版内核 | distro kernel | 发行版（RHEL、Ubuntu 等）基于主线内核打包的内核 |
| patch series | patch series | 一组相关补丁，通常用于新功能或大改动 |
| backport | backport | 将新功能或修复移植到旧内核版本 |
| upstream | upstream | 指主线内核，相对于发行版内核的 downstream |
| downstream | downstream | 指发行版内核或其他定制内核 |
| kernel.org | kernel.org | 内核主要托管站点 |
| kernel.org CVE | CVE announcements | kernel.org 发布的 CVE 公告 |
| KernelNewbies | KernelNewbies.org | 内核新手社区，提供内核发布总结 |
| LPC | Linux Plumbers Conference | Linux 程序员大会 |
| Kernel Summit | Kernel Summit | 内核开发者峰会 |
| netdev | netdev 邮件列表 | 网络开发邮件列表 |
| linux-mm | linux-mm 邮件列表 | 内存管理邮件列表 |
| linux-fsdevel | linux-fsdevel 邮件列表 | 文件系统开发邮件列表 |
| linux-block | linux-block 邮件列表 | 块设备邮件列表 |
| linux-pm | linux-pm 邮件列表 | 电源管理邮件列表 |
| linux-riscv | linux-riscv 邮件列表 | RISC-V 架构邮件列表 |
| linux-arm-kernel | linux-arm-kernel 邮件列表 | ARM 架构邮件列表 |
| dri-devel | dri-devel 邮件列表 | 显示渲染内核邮件列表 |
| kvm | kvm 邮件列表 | 内核虚拟机邮件列表 |
| w1 | w1 邮件列表 | 单总线子系统邮件列表 |

---

## 命名约定

| 项目 | 值 | 范围 |
|---|---|---|
| 站名 | KernelHOT | 全站 |
| 行业词 | Linux 内核 | site.ts 的 subject 字段 |
| 界面语言 | zh-CN | HTML lang、og:locale |
| MCP 前缀 | kernelhot | 所有 MCP 工具名前缀 |
| 爬取器标识 | KernelHOTBot/1.0 | User-Agent |

---

## 分类键（上线后不可更改）

| key | label | 用于 |
|---|---|---|
| security | 安全与修复 | 网址 /all?category=security、RSS feed |
| release | 版本与主线 | 同上 |
| subsystem | 子系统进展 | 同上 |
| driver | 硬件与驱动 | 同上 |
| performance | 性能与可靠性 | 同上 |
| distro | 发行版内核 | 同上 |
| community | 社区与治理 | 同上 |
| article | 技术解读 | 同上 |

---

## 内容类型键

| key | 中文说明 | 对应分类 |
|---|---|---|
| kernel_release | 版本发布 | 版本与主线 |
| security_fix | 安全修复 | 安全与修复 |
| subsystem_change | 子系统改动 | 子系统进展 |
| driver_update | 驱动更新 | 硬件与驱动 |
| performance | 性能变化 | 性能与可靠性 |
| distro_kernel | 发行版内核 | 发行版内核 |
| community_governance | 社区治理 | 社区与治理 |
| technical_article | 技术解读 | 技术解读 |

---

## 公司实体 ID（topics.json / ENTITIES）

| id | name |
|---|---|
| red-hat | Red Hat |
| suse | SUSE |
| canonical | Canonical |
| google | Google |
| intel | Intel |
| amd | AMD |
| nvidia | NVIDIA |
| arm | Arm |
| ibm | IBM |
| oracle | Oracle |
| microsoft | Microsoft |
| amazon-aws | Amazon / AWS |
| meta | Meta |
| huawei | 华为 |
| alibaba | 阿里巴巴 |
| tencent | 腾讯 |
| linux-foundation | Linux Foundation |
