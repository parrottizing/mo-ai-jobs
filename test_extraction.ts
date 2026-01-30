import fs from "node:fs";
import { fetchJobDetails } from "./src/details";
import { JobListing } from "./src/listings";

async function test() {
    const job: JobListing = {
        id: "9365",
        title: "5G AI Automation Intern",
        url: "https://www.moaijobs.com/job/5g-ai-automation-intern-dell-technologies-9365?utm_source=email"
    };

    console.log("Fetching job details... This may take a few seconds (headless browser).");
    try {
        const details = await fetchJobDetails(job);

        // Write full description to file
        fs.writeFileSync("extraction_result.txt", details.description, "utf8");
        console.log("\n[SUCCESS] Full extracted text saved to: extraction_result.txt");

        console.log("\n--- EXTRACTED TITLE ---");
        console.log(details.title);

        console.log("\n--- EXTRACTED DESCRIPTION (FIRST 500 CHARS) ---");
        console.log(details.description.substring(0, 500) + "...");

        console.log("\n--- EXTRACTED DESCRIPTION (LAST 500 CHARS) ---");
        console.log("..." + details.description.substring(details.description.length - 500));

        console.log("\n--- DESCRIPTION LENGTH ---");
        console.log(details.description.length, "characters");

        const cutoffMarkers = [
            "Similar Jobs",
            "Browse all AI jobs",
            "Looking for something different?",
            "Post a Job",
            "Share this job opportunity"
        ];

        console.log("\n--- CUTOFF CHECK ---");
        for (const marker of cutoffMarkers) {
            if (details.description.includes(marker)) {
                console.log(`[FAILED] Description contains cutoff marker: "${marker}"`);
            } else {
                console.log(`[PASSED] Description does not contain: "${marker}"`);
            }
        }
    } catch (error) {
        console.error("Test failed:", error);
    }
}

test();
