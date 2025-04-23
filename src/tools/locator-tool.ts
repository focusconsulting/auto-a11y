import { Page, Locator } from "@playwright/test";
import { Tool } from "./base-tool";
import { A11yAILocator } from "../a11y-ai-locator";

export class LocatorTool implements Tool {
  name = "locateElement";
  description = "Locates an element on the page using a natural language description";
  
  private aiLocator: A11yAILocator;

  constructor(aiLocator: A11yAILocator) {
    this.aiLocator = aiLocator;
  }

  async execute(params: { description: string }): Promise<Locator> {
    return this.aiLocator.locate(params.description);
  }
}
