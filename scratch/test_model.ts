import { loadConfig } from "../src/config";
import { classifyJob } from "../src/classifier";

async function testModel(modelName: string) {
  const config = loadConfig();
  console.log(`Testing model: ${modelName}`);
  
  const job = {
    id: "test-job",
    title: "AI Engineer",
    detailUrl: "https://example.com",
    company: "Test Co",
    location: "Remote",
    tags: ["AI", "Python"],
    descriptionText: "Looking for an AI engineer with 5 years of experience in LLMs and prompt engineering."
  };

  try {
    const result = await classifyJob(job, {
      apiKey: config.googleApiKey,
      model: modelName
    });
    console.log(`[${modelName}] Classification result: ${result.match ? "YES" : "NO"}`);
    console.log(`[${modelName}] Rationale: ${result.rationale}`);
  } catch (error) {
    console.error(`[${modelName}] Test failed:`, error);
  }
}

async function runTests() {
  await testModel("gemma-4-26b-a4b-it");
  await testModel("gemini-3-flash-preview");
}

runTests();
