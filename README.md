# mcp-housing-intel

Housing Intel MCP — Meta-pack that chains FRED, BLS, ATTOM, and HUD APIs

Part of the [Pipeworx](https://pipeworx.io) open MCP gateway.

## Tools

| Tool | Description |
|------|-------------|

## Quick Start

Add to your MCP client config:

```json
{
  "mcpServers": {
    "housing-intel": {
      "url": "https://gateway.pipeworx.io/housing-intel/mcp"
    }
  }
}
```

Or use the CLI:

```bash
npx pipeworx use housing-intel
```

## License

MIT
