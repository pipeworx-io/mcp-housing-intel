# mcp-housing-intel

Housing Intel MCP — Meta-pack that chains FRED, BLS, ATTOM, and HUD APIs

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `case_shiller_metro_compare` | Compare Case-Shiller home price indices across multiple US metros in one call (the 20-city composite). For each metro returns latest level, 3-month change, 12-month change, all-time peak, drawdown from peak, and a softening flag. Output also ranks metros softest → strongest. Use for "which metros are softening", "Case-Shiller for [list of cities]", "compare housing prices in X, Y, Z" queries — picks the right per-metro FRED series IDs (DNXRSA, PHXRSA, TPXRSA, etc.) so callers don't have to. Available metros: Atlanta, Boston, Charlotte, Chicago, Cleveland, Dallas, Denver, Detroit, Las Vegas, Los Angeles, Miami, Minneapolis, New York, Phoenix, Portland, San Diego, San Francisco, Seattle, Tampa, Washington DC. |
| `housing_market_snapshot` | Get national housing market overview: mortgage rates, housing starts, Case-Shiller index, unemployment, construction employment. Optionally add metro-level prices (e.g., "Denver", "Atlanta"). For comparing Case-Shiller across multiple metros use case_shiller_metro_compare instead. |
| `housing_property_report` | Analyze a property by address and zip code. Returns valuation estimate, sales history, tax assessment, and detailed characteristics. |
| `housing_rental_analysis` | Evaluate rental investment potential by address and zip code. Returns estimated rent, fair market rents, and CPI rent trends. |
| `housing_affordability_check` | Check housing affordability in a market. Returns mortgage rate, median price, monthly payment, required income, and HUD limits. Optionally specify metro (e.g., "Denver"). |
| `housing_employment_outlook` | Assess labor market health for housing demand. Returns employment, construction jobs, residential building employment, unemployment rate, and job openings. |
| `housing_signal_scan` | Scan 45+ housing indicators for anomalies and reversals. Flags unusual moves across rates, starts, sales, prices, wages, unemployment, and rent. |
| `housing_mortgage_history` | Freddie Mac Primary Mortgage Market Survey — the weekly US mortgage INTEREST rate (the annual percentage borrowers pay on a home loan, e.g. 6.5%), back to 1971. This is the borrowing cost paid by home buyers. Returns the latest snapshot, a time series for the requested window, and min/max/avg stats. Sourced from Freddie Mac directly (not FRED), ingested weekly by the Pipeworx data pipeline. |
| `housing_market_screen` | Rank US metros for rental cash flow in ONE call — the "which markets are best for a landlord" view. Returns metros sorted by gross rent yield = (Zillow median monthly rent × 12) ÷ Zillow typical home value. No per-metro orchestration and no API key. Use for "best/worst rental markets", "highest-yield metros", "where does rent go furthest vs. home prices". Tune with direction (top = highest yield / best cash flow, bottom = lowest), limit, and optional home-value bounds. |
| `housing_metro_demand` | Demand + rent-durability signals for a shortlist of US metros in ONE call — population & 5-year growth, renter share, median household income, and unemployment, straight from Census ACS. Deterministic by metro (CBSA-keyed) — NO FRED series-ID guessing. Pass `metros` ("City, ST", e.g. the top results from housing_market_screen). This is the Stage-2 "is the demand real?" filter on a yield shortlist — high yield in a shrinking metro is a trap. No API key needed. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "housing-intel": {
      "url": "https://gateway.pipeworx.io/housing-intel/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/housing-intel/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Housing Intel data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
