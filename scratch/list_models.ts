import { loadConfig } from "../src/config";

async function listModels() {
  const config = loadConfig();
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${config.googleApiKey}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error listing models:", error);
  }
}

listModels();
