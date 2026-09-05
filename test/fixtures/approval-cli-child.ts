Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
const { runCli } = await import('../../cli.js');
await runCli(process.argv.slice(2));
