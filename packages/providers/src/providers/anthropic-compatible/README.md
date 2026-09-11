# Anthropic-compatible provider

This adapter connects Anthropic Messages requests to a configured backend. It handles endpoint construction, account authentication, headers, streaming, and rate-limit metadata.

```typescript
import { AnthropicCompatibleProvider } from "@clankermux/providers";

const provider = new AnthropicCompatibleProvider({
  name: "my-service",
  baseUrl: "https://api.example.com",
  authType: "api_key",
  authHeader: "x-api-key",
});
```

Model selection belongs to the central routing table. The adapter preserves the resolved upstream model; it does not apply account mappings, static mappings, or ordered model fallbacks. Configure account model permissions and a routing rule to select a different target.

See [routing setup and acceptance](../../../../../docs/routing-table-implementation.md).
