# Agent Note: 自定义提供方的无密钥请求

Status: implemented

[English](2026-11-18-keyless-custom-providers.md) | 中文

## Problem

自建推理端点可以在没有令牌时处理请求。但是，OpenAI 兼容 SDK 要求非空的初始化密钥，导致明确不使用认证的自定义路由在到达端点之前就失败。

## Decision

[提供方构造](../../../../packages/llm/llm-pi-ai/src/provider.ts)包装没有声明凭据引用的自定义路由。只有既没有明确密钥、也没有认证头的请求才会获得 SDK 初始化选项。SDK 的初始化值不是凭据：空值头覆盖会在发送前删除 Authorization 和 x-api-key。带有明确密钥或认证头的请求保留其认证方式，已安装 catalog 路由也保留原生凭据发现。

## Alternatives considered

要求用户配置占位令牌会错误描述无需认证的端点，并发送多余的凭据。全局 fetch 拦截器会耦合并发提供方，并可能删除其他路由的认证信息。该包装把初始化和头删除限制在单个自定义提供方的请求内。

## Consequences

无需令牌的 OpenAI 兼容服务器可以接收不带认证头的请求。无法解析的具名凭据仍会在发送前导致失败。提供方的专项测试检查实际 HTTP 头和流的成功完成；无密钥 headless 示例通过构建后的 DSH 启动器加载 Hive profile，并记录完成状态和传输元数据。
