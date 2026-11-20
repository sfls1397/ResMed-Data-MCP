export type CliCommand = "indexer" | "serve" | "backfill" | "http-token";

const VALID_COMMANDS: ReadonlySet<string> = new Set(["indexer", "serve", "backfill", "http-token"]);

export function getCliCommand(argv: string[] = process.argv): CliCommand {
  const positional = argv[2];
  if (positional && VALID_COMMANDS.has(positional)) {
    return positional as CliCommand;
  }
  return "serve";
}
