# A11y AI Locator

A powerful tool that combines AI with accessibility-first element selection and natural language automation for Playwright tests.

## Overview

A11yAILocator is a Playwright utility that uses AI to generate accessible selectors for web elements based on natural language descriptions. It leverages multiple AI providers to analyze page content and determine the most appropriate Testing Library query for locating elements.

The library now includes an AIAgent that can interpret natural language instructions to perform actions on the page, making test automation even more intuitive.

## Features

- **Natural Language Element Selection**: Find elements using human-readable descriptions
- **Natural Language Actions**: Perform actions using plain English instructions
- **Accessibility-First Approach**: Prioritizes accessible selectors following Testing Library best practices
- **Multiple AI Providers**: 
  - **Ollama**: Local models like `llama3` or `mistral`
  - **Anthropic**: Claude models like `claude-3-haiku-20240307` or `claude-3-opus-20240229`
  - **OpenAI**: Models like `gpt-4o-mini` or `gpt-4o`
  - **Google Gemini**: Models like `gemini-2.5-pro-exp-03-25`
  - **DeepSeek**: Models like `deepseek-chat`
  - **Bedrock**: AWS Bedrock models
- **Simplified HTML Option**: Can use simplified HTML for better AI processing
- **Snapshot Support**: Saves successful locators to JSON files for faster test runs
- **Testing Library Integration**: Uses the same query priority as Testing Library:
  1. `getByRole` - ARIA roles with accessible names
  2. `getByText` - Text content matching
  3. `getByLabelText` - Form elements with labels
  4. `getByPlaceholderText` - Input placeholders
  5. `getByTestId` - Data test IDs
  6. `getByAltText` - Image alt text
- **Tool-Based Architecture**: Modular design makes it easy to add new capabilities

## Usage

### Basic Locator Example

```typescript
import { test, expect } from '@playwright/test';
import { createA11yAILocator } from './src/a11y-ai-locator';

test('example test', async ({ page }, testInfo) => {
  // Create an instance with Anthropic Claude (default model: claude-3-haiku-20240307)
  const locator = createA11yAILocator(page, testInfo, test, {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY
  });
  
  await page.goto('https://example.com');
  
  // Find elements using natural language
  const heading = await locator.locate('the main heading');
  const button = await locator.locate('the submit button');
  
  await expect(heading).toBeVisible();
  await expect(button).toBeEnabled();
});
```

### Using the AI Agent

```typescript
import { test, expect } from '@playwright/test';
import { createAIAgent } from './src/ai-agent';

test('example test with AI agent', async ({ page }, testInfo) => {
  // Create an AI agent with Anthropic Claude
  const agent = createAIAgent(page, testInfo, test, {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY
  });
  
  await page.goto('https://example.com/login');
  
  // Execute natural language instructions
  await agent.execute('type "testuser@example.com" in the email field');
  await agent.execute('enter "password123" in the password field');
  await agent.execute('click the login button');
  
  // You can also use the locate method directly when needed
  const welcomeMessage = await agent.locate('the welcome message');
  await expect(welcomeMessage).toBeVisible();
});
```

### Using Different Providers

```typescript
// Using OpenAI
const openaiLocator = createA11yAILocator(page, testInfo, test, {
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY
});

// Using Google Gemini
const geminiLocator = createA11yAILocator(page, testInfo, test, {
  provider: 'gemini',
  model: 'gemini-2.5-pro-exp-03-25',
  apiKey: process.env.GEMINI_API_KEY
});

// Using Ollama (local)
const ollamaLocator = createA11yAILocator(page, testInfo, test, {
  provider: 'ollama',
  model: 'llama3',
  baseUrl: 'http://localhost:11434'
});

// Using DeepSeek
const deepseekLocator = createA11yAILocator(page, testInfo, test, {
  provider: 'deepseek',
  model: 'deepseek-chat',
  apiKey: process.env.DEEPSEEK_API_KEY
});

// Using AWS Bedrock
const bedrockLocator = createA11yAILocator(page, testInfo, test, {
  provider: 'bedrock',
  model: 'anthropic.claude-3-sonnet-20240229-v1:0',
  apiKey: process.env.AWS_ACCESS_KEY_ID
  // Note: AWS_SECRET_ACCESS_KEY should be set as an environment variable
});
```

### Advanced Configuration

```typescript
const locator = createA11yAILocator(page, testInfo, test, {
  provider: 'anthropic',
  model: 'claude-3-haiku-20240307',
  apiKey: process.env.ANTHROPIC_API_KEY,
  snapshotFilePath: './custom-snapshots/my-test.json',  // Custom snapshot location
  useSimplifiedHtml: true,  // Use simplified HTML for better AI processing
});
```

## How It Works

### A11yAILocator

1. **Description Analysis**: When you call `locate()` with a description, the system first checks if there's a cached selector in the snapshot file.

2. **HTML Extraction**: If no cached selector exists, it extracts the current page's HTML.

3. **AI Processing**: The HTML and description are sent to the AI model with a prompt that explains Testing Library's query priority.

4. **Selector Generation**: The AI returns the most appropriate Testing Library query type and parameters.

5. **Locator Creation**: The system creates a Playwright locator using the suggested query.

6. **Snapshot Saving**: Successful locators are saved to a JSON file for future use.

### AIAgent

1. **Instruction Analysis**: When you call `execute()` with an instruction, the agent extracts the current page's HTML.

2. **AI Planning**: The HTML and instruction are sent to the AI model, which determines:
   - What action to perform (click, fill, etc.)
   - Which element to target
   - Any additional values needed (text to type, etc.)

3. **Tool Usage**: The agent uses the LocatorTool to find the target element.

4. **Action Execution**: The agent performs the specified action on the located element.

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
- For cloud AI: API keys for your chosen provider(s)
  - Anthropic API key for Claude
  - OpenAI API key for GPT models
  - Google API key for Gemini
  - DeepSeek API key
  - AWS credentials for Bedrock

## License

MIT
