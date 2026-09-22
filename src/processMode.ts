export type CliCommand = "indexer" | "serve" | "backfill";

const VALID_COMMANDS: ReadonlySet<string> = new Set(["indexer", "serve", "backfill"]);

/**
 * `resmed-data-mcp indexer`  -> always-on backfill + poll loop (LaunchAgent A)
 * `resmed-data-mcp serve`    -> always-on read-only MCP HTTP server (LaunchAgent B, default)
 * `resmed-data-mcp backfill` -> one-shot manual backfill, then exit
 */
export function getCliCommand(argv: string[] = process.argv): CliCommand {
  const positional = argv[2];
  if (positional && VALID_COMMANDS.has(positional)) {
    return positional as CliCommand;
  }
  return "serve";
}
