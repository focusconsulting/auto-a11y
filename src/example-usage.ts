import { test, expect } from '@playwright/test';
import { createOllamaLocator } from './ollama-locator';

test('use ollama locator to find elements', async ({ page }) => {
  // Navigate to a page
  await page.goto('https://example.com');
  
  // Create the Ollama locator
  const ollamaLocator = createOllamaLocator(page);
  
  // Use the locator to find elements by description
  const heading = await ollamaLocator.locate('the main heading of the page');
  
  // You can use the returned locator like any other Playwright locator
  await expect(heading).toBeVisible();
  const text = await heading.textContent();
  console.log('Found heading text:', text);
});
