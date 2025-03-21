import { test, expect, TestInfo } from "@playwright/test";
import { createA11yAILocator } from "../src/a11y-ai-locator";

test("should complete the FAFSA parent application form wizard", async ({
  browser,
}, testInfo: TestInfo) => {
  // Create an instance of A11yAILocator

  const context = await browser.newContext({
    recordVideo: {
      dir: "./"
    },
    // Force HTTP/1.1 instead of HTTP/2
    extraHTTPHeaders: {
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "sec-ch-ua": "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    },
    // Add user agent to appear more like a regular
    // browser
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  });
  // Create a new page from our custom context
  const page = await context.newPage();
  const a11yLocator = createA11yAILocator(page, testInfo);

  // Navigate to the FAFSA parent application page
  await page.goto("https://studentaid.gov/fafsa-apply/parents");

  // Wait for the page to load
  await page.waitForLoadState("networkidle");

  // Verify we're on the correct page by checking the heading
  const heading = await a11yLocator.locate(
    "main heading about parent information"
  );
  await expect(heading).toBeVisible();

  // Start the application process
  const startButton = await a11yLocator.locate(
    "button to start the parent information process"
  );
  await startButton.click();

  // Wait for the form to load
  await page.waitForLoadState("networkidle");

  // Fill out parent information section
  // Note: Using test data - in a real test you would use environment variables or test fixtures

  // Parent's name
  const firstNameField = await a11yLocator.locate(
    "first parent first name input field"
  );
  await firstNameField.fill("John");

  const lastNameField = await a11yLocator.locate(
    "second parent first name input field"
  );
  await lastNameField.fill("Anne");


  // Continue to next section
  const continueButton = await a11yLocator.locate(
    "continue to next section button"
  );
  await continueButton.click();

  // Wait for the next section to load
  await page.waitForLoadState("networkidle");

  const yesRadio = await a11yLocator.locate("the yes radio button")
  await yesRadio.click()

  const canStartLink = await a11yLocator.locate("the button about whether a parent can start the form ")
  await canStartLink.click()

  const yesInfo = await a11yLocator.locate("the section that contains 'Yes, a parent can start a FAFSA form for a dependent student.'")
  await expect(yesInfo).toBeVisible()

  // Take a screenshot of the completed form
  await page.screenshot({ path: "fafsa-parent-form-completed.png" });
  await context.close()
});
