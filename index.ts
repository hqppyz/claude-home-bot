import { ConfigError, loadConfig, type Config } from "./src/config";
import { resolveDirs } from "./src/dirs";
import { startBot } from "./src/bot";

let config: Config;
let dirs: string[][];
try {
  config = await loadConfig();
  dirs = await Promise.all(config.paths.map(resolveDirs));
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(`config error: ${e.message}`);
  process.exit(1);
}

config.paths.forEach((entry, i) => {
  console.log(`${entry.path} (${entry.mode})`);
  for (const dir of dirs[i]!) console.log(`  ${dir}`);
});

await startBot(config);
