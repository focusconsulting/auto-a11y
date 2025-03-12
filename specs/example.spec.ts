import { test, expect, TestInfo } from '@playwright/test';
import { createA11yAILocator } from '../src/a11y-ai-locator';


  test('should navigate to example.com and find elements using AI-generated selectors', async ({ page }, testInfo: TestInfo) => {
    // Create an instance of A11yAILocator
    const ollamaLocator = createA11yAILocator(page, testInfo);
    
    // Navigate to example.com
    await page.goto('https://example.com');
    
    // Wait for the page to load
    await page.waitForLoadState('networkidle');
    
    // Use OllamaLocator to find elements with natural language descriptions
    const heading = await ollamaLocator.locate('the main heading of the page');
    const moreInfoLink = await ollamaLocator.locate('link about more information');
    const paragraph = await ollamaLocator.locate('the main paragraph on the page');
    
    // Verify the elements exist and have the expected content
    await expect(heading).toBeVisible();
    await expect(heading).toHaveText('Example Domain');
    
    await expect(paragraph).toBeVisible();
    await expect(paragraph).toContainText('This domain is for use in illustrative examples');
    
    await expect(moreInfoLink).toBeVisible();
    await expect(moreInfoLink).toHaveAttribute('href', 'https://www.iana.org/domains/example');
  });

