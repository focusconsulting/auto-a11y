<!-- AI! update this readme to reflect the usage of a11y-ai-locator and document the provider/models -->
# A11y AI Locator

A powerful tool that combines AI with accessibility-first element selection for Playwright tests.

## Overview

A11yAILocator is a Playwright utility that uses AI to generate accessible selectors for web elements based on natural language descriptions. It leverages either Ollama (local) or Anthropic Claude (cloud) to analyze page content and determine the most appropriate Testing Library query for locating elements.

## Features

- **Natural Language Element Selection**: Find elements using human-readable descriptions
- **Accessibility-First Approach**: Prioritizes accessible selectors following Testing Library best practices
- **Multiple AI Backends**: 
  - Local: Ollama with models like `deep-seek-auto-a11y`
  - Cloud: Anthropic Claude models like `claude-3-7`
- **Snapshot Support**: Saves successful locators to JSON files for faster test runs
- **Testing Library Integration**: Uses the same query priority as Testing Library:
  1. `getByRole` - ARIA roles with accessible names
  2. `getByText` - Text content matching
  3. `getByLabelText` - Form elements with labels
  4. `getByPlaceholderText` - Input placeholders
  5. `getByTestId` - Data test IDs
  6. `getByAltText` - Image alt text

## Installation

```bash
npm install --save-dev @playwright/test ollama
# For Claude support
npm install --save-dev @anthropic-ai/sdk
```

## Usage

### Basic Example

```typescript
import { test, expect } from '@playwright/test';
import { createA11yAILocator } from './src/a11y-ai-locator';

test('example test', async ({ page }, testInfo) => {
  // Create an instance with default settings (Ollama)
  const locator = createA11yAILocator(page, testInfo);
  
  await page.goto('https://example.com');
  
  // Find elements using natural language
  const heading = await locator.locate('the main heading');
  const button = await locator.locate('the submit button');
  
  await expect(heading).toBeVisible();
  await expect(button).toBeEnabled();
});
```

### Using Claude

```typescript
const locator = createA11yAILocator(page, testInfo, {
  model: 'claude-3-7',
  apiKey: process.env.ANTHROPIC_API_KEY
});
```

### Custom Configuration

```typescript
const locator = createA11yAILocator(page, testInfo, {
  model: 'deep-seek-auto-a11y',  // Ollama model
  baseUrl: 'http://localhost:11434',  // Ollama server URL
  snapshotFilePath: './custom-snapshots/my-test.json'  // Custom snapshot location
});
```

## How It Works

1. **Description Analysis**: When you call `locate()` with a description, the system first checks if there's a cached selector in the snapshot file.

2. **HTML Extraction**: If no cached selector exists, it extracts the current page's HTML.

3. **AI Processing**: The HTML and description are sent to the AI model with a prompt that explains Testing Library's query priority.

4. **Selector Generation**: The AI returns the most appropriate Testing Library query type and parameters.

5. **Locator Creation**: The system creates a Playwright locator using the suggested query.

6. **Snapshot Saving**: Successful locators are saved to a JSON file for future use.

## Snapshots

Snapshots are saved in the `locator-snapshots` directory by default, with filenames based on the test title. Each snapshot file contains a mapping of descriptions to Testing Library queries:

```json
{
  "the main heading": {
    "queryName": "getByRole",
    "params": ["heading", "Example Domain"]
  },
  "the more info link": {
    "queryName": "getByText",
    "params": ["More information..."]
  }
}
```

## Best Practices

1. **Be Specific**: Use clear, specific descriptions that uniquely identify elements.

2. **Prioritize Accessibility**: The system works best when pages follow accessibility best practices with proper ARIA roles, labels, etc.

3. **Reuse Descriptions**: Using consistent descriptions across tests helps build a robust snapshot cache.

4. **Check Snapshots**: Review generated snapshots to understand which selectors are being used.

## Requirements

- Playwright
- Node.js 16+
- For local AI: Ollama running with appropriate models
- For cloud AI: Anthropic API key

## License

MIT
