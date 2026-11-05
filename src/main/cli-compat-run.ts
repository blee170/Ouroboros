/**
 * The compatibility check as its own process: `node cli-compat-run.js [engine…]` prints one JSON array of
 * CompatReport on stdout. Built as ONE self-contained file (out/main/cli-compat-run.js, like mcp-server.js) and
 * started by the app (main/cli-watch.ts), so the file search never runs in the main process.
 */
import { CLI_CONTRACTS } from '../shared/cli-contract'
import { checkCli, type CompatReport } from './cli-compat'

async function main(argv: string[]): Promise<void> {
  const only = argv.filter((a) => !a.startsWith('-'))
  // the app may run this file with its own binary as node: the CLIs it starts must not inherit that switch
  delete process.env.ELECTRON_RUN_AS_NODE
  const reports: CompatReport[] = []
  for (const c of CLI_CONTRACTS) {
    if (only.length && !only.includes(c.engine)) continue
    try {
      reports.push(await checkCli(c))
    } catch (e) {
      // one CLI that cannot be read does not hide the others
      reports.push({ engine: c.engine, installed: true, lines: [], error: (e as Error).message || 'the check failed' })
    }
  }
  process.stdout.write(JSON.stringify(reports))
}

if (require.main === module) {
  void main(process.argv.slice(2)).then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(String((e as Error)?.message ?? e))
      process.exit(1)
    }
  )
}
