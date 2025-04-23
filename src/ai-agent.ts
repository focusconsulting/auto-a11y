import { Page, Locator, TestInfo } from "@playwright/test";
import { A11yAILocator, createA11yAILocator } from "./a11y-ai-locator";
import { Tool } from "./tools/base-tool";
import { LocatorTool } from "./tools/locator-tool";
import { extractBodyContent } from "./sanitize-html";

export class AIAgent {
  private page: Page;
  private aiLocator: A11yAILocator;
  private tools: Tool[] = [];
  private testInstance: any;

  constructor(
    page: Page,
    testInfo: TestInfo,
    testInstance: any,
    options: {
      model?: string;
      provider: "ollama" | "anthropic" | "openai" | "gemini" | "deepseek" | "bedrock";
      baseUrl?: string;
      snapshotFilePath?: string;
      apiKey?: string;
      useSimplifiedHtml?: boolean;
    }
  ) {
    this.page = page;
    this.testInstance = testInstance;
    
    // Create the A11yAILocator instance
    this.aiLocator = createA11yAILocator(page, testInfo, testInstance, options);
    
    // Register tools
    this.registerTool(new LocatorTool(this.aiLocator));
  }

  /**
   * Registers a tool with the agent
   * @param tool The tool to register
   */
  registerTool(tool: Tool): void {
    this.tools.push(tool);
  }

  /**
   * Executes a natural language instruction with retry logic for JSON parsing
   * @param instruction Natural language instruction (e.g., "click the submit button")
   * @param maxRetries Maximum number of retry attempts (default: 2)
   * @returns Promise that resolves when the action is complete
   */
  async execute(instruction: string, maxRetries: number = 2): Promise<void> {
    // Get the current page HTML
    const html = await this.page.content();
    const bodyContent = extractBodyContent(html);
    
    // Create a description of available tools
    const toolDescriptions = this.tools.map(tool => 
      `${tool.name}: ${tool.description}`
    ).join('\n');
    
    // Create the base prompt for the AI
    const basePrompt = `
You are an expert in web automation with Playwright. Given the HTML below and an instruction,
determine the action to perform and which elements to target.

You have access to the following tools:
${toolDescriptions}

First, analyze the instruction to determine:
1. What action to perform (click, fill, check, etc.)
2. Which element to target
3. Any additional values needed (text to type, etc.)
4. If multiple elements might match, specify which one using a zero-based index (0 for first, 1 for second, etc.)

Then, create a plan that uses the available tools to execute the instruction.

Return ONLY a JSON object with the following format:
{
  "action": "click" | "fill" | "check" | "uncheck" | "select" | "press" | "hover" | "dblclick" | "focus" | "tap",
  "targetDescription": "description of the element to locate",
  "value": "optional value for fill/select/press actions",
  "index": 0 | 1 | 2 | -1 | null
}

For example:
{"action": "click", "targetDescription": "the submit button", "value": null, "index": null}
{"action": "fill", "targetDescription": "the email field", "value": "user@example.com", "index": null}
{"action": "click", "targetDescription": "services link", "value": null, "index": 0}
{"action": "click", "targetDescription": "services link", "value": null, "index": -1} // last element

HTML:
${bodyContent}

Instruction: ${instruction}
`;

    let retries = 0;
    let lastError = null;
    let prompt = basePrompt;

    while (retries <= maxRetries) {
      try {
        // Execute the prompt with the AI
        const response = await this.aiLocator.executePrompt(prompt, {
          systemPrompt: "You are a web automation assistant that helps users interact with web pages using natural language. Return ONLY valid JSON with no additional text or explanation."
        });
        
        // Parse the AI response
        let actionPlan;
        try {
          actionPlan = JSON.parse(response);
        } catch (parseError) {
          // If JSON parsing fails, create a more specific error message for the retry
          throw new Error(`Invalid JSON response: ${response}`);
        }
        
        // Execute the action plan
        return this.testInstance
          ? await this.testInstance.step(
              `auto-a11y: ${instruction}`,
              async () => {
                await this.executeActionPlan(actionPlan);
              }
            )
          : await this.executeActionPlan(actionPlan);
      } catch (error) {
        lastError = error;
        
        if (retries < maxRetries) {
          // Create a retry prompt that includes the error message
          prompt = `
${basePrompt}

Your previous response could not be parsed as valid JSON. Please try again and ensure you return ONLY a valid JSON object with no additional text, comments, or formatting.

Error: ${error instanceof Error ? error.message: "unknown error"}
`;
          retries++;
          console.warn(`Retry ${retries}/${maxRetries} for instruction: "${instruction}"`);
        } else {
          // We've exhausted our retries
          console.error(`Failed to execute instruction after ${maxRetries} retries: ${error}`);
          throw new Error(`Failed to execute instruction "${instruction}" after ${maxRetries} retries: ${error}`);
        }
      }
    }
    
    // This should never be reached due to the throw in the else block above
    throw lastError;
  }

  /**
   * Executes an action plan generated by the AI
   * @param actionPlan The action plan to execute
   */
  private async executeActionPlan(actionPlan: {
    action: string;
    targetDescription: string;
    value: string | null;
    index: number | null;
  }): Promise<void> {
    // Use the locator tool to find the target element
    const locatorTool = this.tools.find(tool => tool.name === "locateElement") as LocatorTool;
    if (!locatorTool) {
      throw new Error("Locator tool not found");
    }
    
    const targetLocator = await locatorTool.execute({ description: actionPlan.targetDescription });
    
    // Apply the index selector if specified
    const indexedLocator = this.applyIndexSelector(targetLocator, actionPlan.index);
    
    // Perform the action
    await this.executeAction(indexedLocator, actionPlan.action, actionPlan.value);
  }
  
  /**
   * Applies an index selector to a locator
   * @param locator The original locator
   * @param index The zero-based index to apply, or null for no indexing
   * @returns A new locator with the index applied
   */
  private applyIndexSelector(locator: Locator, index: number | null): Locator {
    if (index === null) return locator;
    
    if (index === -1) {
      return locator.last();
    } else if (index >= 0) {
      return locator.nth(index);
    }
    
    return locator;
  }

  /**
   * Executes a specific Playwright action on a locator
   * @param locator The target element locator
   * @param action The action to perform
   * @param value Optional value for actions that require it
   */
  private async executeAction(
    locator: Locator,
    action: string,
    value: string | null
  ): Promise<void> {
    switch (action) {
      case 'click':
        await locator.click();
        break;
      case 'fill':
        if (value === null) {
          throw new Error('Value is required for fill action');
        }
        await locator.fill(value);
        break;
      case 'check':
        await locator.check();
        break;
      case 'uncheck':
        await locator.uncheck();
        break;
      case 'select':
        if (value === null) {
          throw new Error('Value is required for select action');
        }
        await locator.selectOption(value);
        break;
      case 'press':
        if (value === null) {
          throw new Error('Key is required for press action');
        }
        await locator.press(value);
        break;
      case 'hover':
        await locator.hover();
        break;
      case 'dblclick':
        await locator.dblclick();
        break;
      case 'focus':
        await locator.focus();
        break;
      case 'tap':
        await locator.tap();
        break;
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  }

  /**
   * Convenience method to directly locate an element
   * @param description Description of the element to locate
   * @returns Playwright Locator for the element
   */
  async locate(description: string): Promise<Locator> {
    return this.aiLocator.locate(description);
  }
}

// Helper function to create an AIAgent instance
export function createAIAgent(
  page: Page,
  testInfo: TestInfo,
  testInstance: any,
  options: {
    model?: string;
    provider: "ollama" | "anthropic" | "openai" | "gemini" | "deepseek" | "bedrock";
    baseUrl?: string;
    snapshotFilePath?: string;
    apiKey?: string;
    useSimplifiedHtml?: boolean;
  }
): AIAgent {
  return new AIAgent(page, testInfo, testInstance, options);
}
