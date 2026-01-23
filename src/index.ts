import { loadConfig } from "./config";
import { loadState } from "./state";

export * from "./details";
export * from "./listings";

export async function bootstrap(): Promise<void> {
  const config = loadConfig();
  await loadState(config.stateFilePath);
}

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
