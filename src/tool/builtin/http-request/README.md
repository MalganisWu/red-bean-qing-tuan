# HTTP Request 能力

`http-request-tool.ts` 保存 Tool 参数与响应映射；`http-client.ts` 编排 DNS、策略和连接；
`egress-policy.ts` 拒绝受限地址；`pinned-request.ts` 直接连接已经授权的 IP，避免 DNS rebinding。

默认使用 `PublicInternetOnlyPolicy`。每个解析结果必须先授权再连接，取消与超时必须贯穿 DNS、策略和
响应读取；任何无法确定安全性的地址都应 fail-closed。
