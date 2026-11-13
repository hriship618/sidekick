# Reusable skill and tool packs

Reusable packs are possible, but Rove does not currently have a pack importer or MCP client. This document describes the compatibility boundary, not a shipped feature.

The practical integration is a Rove pack containing:

- **Skills:** task instructions and supporting files, loaded only when relevant.
- **Tools:** MCP server connections, discovered and invoked through validated main-process adapters.
- **Metadata:** pack identity/version, required configuration and a review/enable state.

[MCP](https://modelcontextprotocol.io/docs/learn/architecture) separates tool providers from the AI application, so a tool server can be useful across hosts. [Claude Code plugins](https://code.claude.com/docs/en/plugins-reference) can bundle several components, including skills, commands, hooks and MCP servers. [OpenAI's MCP integration](https://developers.openai.com/plugins/concepts/mcp-server) also uses MCP, but host-specific UI, authorization and lifecycle features are separate from basic tool calling.

That means Rove could reuse compatible MCP tool servers, and adapt supported skill files. It cannot promise that an arbitrary Claude or ChatGPT pack will work unchanged. Hooks, UI widgets, host-specific commands and authentication need explicit adapters or a clear unsupported-component report.

An implementation should import/review a manifest without executing it, require the user to enable executable tool servers, keep credentials out of renderer/config exports, discover only relevant tool definitions, freeze the selected tool profile during each model session, preserve per-tool verification/retry contracts, and route results through the existing evidence reducer. A server that requests interactive login should use Rove's new question/resume chat flow. Disabling/removing a pack must stop its owned connections/processes without replaying actions.

No third-party pack or external tool server was downloaded or enabled in the chat/app-discovery update.
