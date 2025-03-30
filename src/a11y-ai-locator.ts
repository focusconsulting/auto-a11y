import { Page, Locator, TestInfo } from "@playwright/test";
import { Ollama } from "ollama";
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";
import { SnapshotManager } from "./snapshot-manager";
import { createLocatorPrompt, createSimpleLocatorPrompt } from "./prompt";
import { extractBodyContent } from "./sanitize-html";

export class A11yAILocator {
  private page: Page;
  private ollama: Ollama | null = null;
  private anthropic: Anthropic | null = null;
  private model: string;
  private aiProvider: "ollama" | "anthropic";
  private snapshotFilePath: string | null = null;
  private cachedBodyContent: string | null = null;
  private lastHtml: string | null = null;
  private timeout: number;
  private snapshotManager: SnapshotManager;

  constructor(
    page: Page,
    testInfo: TestInfo,
    options: {
      model?: string;
      baseUrl?: string;
      snapshotFilePath?: string;
      apiKey?: string;
      timeout?: number;
    } = {}
  ) {
    this.page = page;
    this.timeout = options.timeout || 60000; // Default 30 seconds

    // Determine which AI provider to use based on the model
    if (
      options.model === "claude-3-7" ||
      options.model?.startsWith("claude-")
    ) {
      this.aiProvider = "anthropic";
      this.model = options.model || "claude-3-7";
      this.anthropic = new Anthropic({
        apiKey: options.apiKey || process.env.ANTHROPIC_API_KEY || "",
      });
    } else {
      this.aiProvider = "ollama";
      this.model = options.model || "deep-seek-auto-a11y";
      this.ollama = new Ollama({
        host: options.baseUrl || "http://localhost:11434",
      });
    }

    // Default to test name if available, otherwise use provided path or null
    if (options.snapshotFilePath) {
      this.snapshotFilePath = options.snapshotFilePath;
    } else {
      this.snapshotFilePath = SnapshotManager.createSnapshotPath(testInfo);
    }

    // Initialize the snapshot manager
    this.snapshotManager = new SnapshotManager(this.snapshotFilePath);
  }

  /**
   * Creates a locator using AI to determine the best Testing Library query
   * @param description Human description of the element to find
   * @returns Playwright Locator for the element
   */
  async locate(description: string): Promise<Locator> {
    // Check if we have a saved snapshot for this description
    const snapshots = this.snapshotManager.readSnapshots();
    if (snapshots[description]) {
      const { queryName, params } = snapshots[description];
      const locator = this.executeTestingLibraryQuery(queryName, params);

      // Verify the locator exists on the page
      const count = await locator.count();
      if (count > 0) {
        return locator;
      }
      // If locator doesn't exist, fall through to generate a new one
    }

    // Get the current page HTML
    const html = await this.page.content();

    // Extract and sanitize only the body content
    let bodyContent: string;

    // Use cached body content if HTML hasn't changed
    if (this.lastHtml === html && this.cachedBodyContent) {
      bodyContent = this.cachedBodyContent;
    } else {
      bodyContent = extractBodyContent(html, description);
      // Cache the results
      this.lastHtml = html;
      this.cachedBodyContent = bodyContent;
    }

    // Create the prompt with the description and body content
    const prompt = createLocatorPrompt(description, bodyContent);

    try {
      // Set up a timeout for the AI request
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("AI request timed out")),
          this.timeout
        );
      });

      // Make the AI request with timeout
      let queryInfo: string;
      console.log(`Prompt size is: ${prompt.length}`);
      if (this.aiProvider === "anthropic" && this.anthropic) {
        const responsePromise = this.anthropic.messages.create({
          model: this.model,
          max_tokens: 1024,
          system:
            "You must always return the COMPLETE text content for getByText queries, never partial matches. For example, if the element contains 'Yes, you can', you must return the entire text 'Yes, you can', not just 'Yes'.",
          messages: [{ role: "user", content: prompt }],
        });

        const response = await Promise.race([responsePromise, timeoutPromise]);
        const textContent = response.content.find(
          (item) => item.type === "text"
        );
        if (textContent && "text" in textContent) {
          queryInfo = textContent.text.trim();
        } else {
          throw new Error("No text content found in Anthropic response");
        }
      } else if (this.ollama) {
        const responsePromise = this.ollama.chat({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
        });

        const response = await Promise.race([responsePromise, timeoutPromise]);
        queryInfo = response.message.content.trim();
      } else {
        throw new Error("No AI provider configured");
      }

      // Parse the JSON response
      let queryName: string;
      let queryParams: string[];

      try {
        // First try to extract JSON if it's wrapped in markdown code blocks
        let jsonString = queryInfo;
        const jsonRegex = /```(?:json)?\s*({[\s\S]*?})\s*```/;
        const match = queryInfo.match(jsonRegex);

        if (match && match[1]) {
          jsonString = match[1];
        }

        const jsonResponse = JSON.parse(jsonString);
        queryName = jsonResponse.query;
        queryParams = jsonResponse.params || [];
      } catch (error) {
        console.warn(
          `Failed to parse JSON response: ${error}. Falling back to text parsing.`
        );

        // Fallback to the old text parsing method
        const [name, ...params] = queryInfo
          .split(":")
          .map((part) => part.trim());

        queryName = name;

        // Handle parameters more carefully to avoid splitting text that contains commas
        if (queryName.toLowerCase() === "getbytext") {
          queryParams = [params.join(":").trim()];
        } else {
          // For other query types, we can split by comma as they typically have separate parameters
          queryParams = params
            .join(":")
            .split(",")
            .map((p) => p.trim());
        }
      }

      // Save the snapshot for future use
      this.snapshotManager.saveSnapshot(description, {
        queryName,
        params: queryParams,
      });

      // Execute the appropriate Testing Library query
      return this.executeTestingLibraryQuery(queryName, queryParams);
    } catch (error) {
      console.warn(
        `AI request failed or timed out: ${error}. Trying with simplified HTML...`
      );

      // Fall back to simplified HTML approach
      try {
        const { queryName, params } = await this.locateWithSimplifiedHTML(
          description,
          html
        );

        // Save the snapshot for future use
        this.snapshotManager.saveSnapshot(description, { queryName, params });

        // Execute the appropriate Testing Library query
        return this.executeTestingLibraryQuery(queryName, params);
      } catch (fallbackError) {
        console.error(`Simplified HTML approach also failed: ${fallbackError}`);

        // Last resort: try a simple text search
        console.warn(
          `Falling back to simple text search for: "${description}"`
        );
        return this.page.getByText(description, { exact: false });
      }
    }
  }


  /**
   * Attempts to locate an element using simplified HTML when the main approach times out
   * @param description The element description
   * @param html The full HTML content
   * @returns Object containing query name and parameters
   */
  private async locateWithSimplifiedHTML(
    description: string,
    html: string
  ): Promise<{ queryName: string; params: string[] }> {
    // Create a much more simplified version of the HTML
    const $ = cheerio.load(html);

    // Keep only essential elements and their text content
    $("*").each((_, el) => {
      const element = $(el);
      // Keep only elements that might be interactive or contain text

      if (el.type == "tag") {
        const tagName = el.tagName?.toLowerCase() || "";
        const isImportant = [
          "a",
          "button",
          "input",
          "select",
          "textarea",
          "label",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "p",
        ].includes(tagName);

        if (
          !isImportant &&
          !element.has("a, button, input, select, textarea, label").length
        ) {
          // Remove attributes except role, aria-* and data-testid
          const attribs = element.attr();
          Object.keys(attribs).forEach((attr) => {
            if (
              attr !== "role" &&
              !attr.startsWith("aria-") &&
              attr !== "data-testid"
            ) {
              element.removeAttr(attr);
            }
          });
        }
      }
    });

    // Get simplified HTML
    const simplifiedHTML = $("body").html() || $.html();

    // Create a simplified prompt
    const prompt = createSimpleLocatorPrompt(description, simplifiedHTML);

    // Get the query suggestion from the appropriate AI provider
    let queryInfo: string;
    console.log(`Prompt size is: ${prompt.length}`);
    if (this.aiProvider === "anthropic" && this.anthropic) {
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: "Return only the query name and parameters. Be concise.",
        messages: [{ role: "user", content: prompt }],
      });
      // Handle different content types in the response
      if (response.content[0].type === "text") {
        queryInfo = response.content[0].text.trim();
      } else {
        // If first content item isn't text, search for the first text item
        const textContent = response.content.find(
          (item) => item.type === "text"
        );
        if (textContent && "text" in textContent) {
          queryInfo = textContent.text.trim();
        } else {
          throw new Error("No text content found in Anthropic response");
        }
      }
    } else if (this.ollama) {
      const response = await this.ollama.chat({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
      });
      queryInfo = response.message.content.trim();
    } else {
      throw new Error("No AI provider configured");
    }

    // Parse the JSON response
    try {
      // First try to extract JSON if it's wrapped in markdown code blocks
      let jsonString = queryInfo;
      const jsonRegex = /```(?:json)?\s*({[\s\S]*?})\s*```/;
      const match = queryInfo.match(jsonRegex);

      if (match && match[1]) {
        jsonString = match[1];
      }

      const jsonResponse = JSON.parse(jsonString);
      const queryName = jsonResponse.query;
      const queryParams = jsonResponse.params || [];
      return { queryName, params: queryParams };
    } catch (error) {
      console.warn(
        `Failed to parse JSON response: ${error}. Falling back to text parsing.`
      );

      // Fallback to the old text parsing method
      const [queryName, ...params] = queryInfo
        .split(":")
        .map((part) => part.trim());

      // Handle parameters more carefully to avoid splitting text that contains commas
      let queryParams: string[] = [];

      // For getByText, we want to preserve the entire text including any commas
      if (queryName.toLowerCase() === "getbytext") {
        queryParams = [params.join(":").trim()];
      } else {
        // For other query types, we can split by comma as they typically have separate parameters
        queryParams = params
          .join(":")
          .split(",")
          .map((p) => p.trim());
      }

      return { queryName, params: queryParams };
    }

    // return { queryName, params: queryParams };
  }

  /**
   * Executes the appropriate Testing Library query based on the AI suggestion
   * @param queryName The name of the Testing Library query
   * @param params The parameters for the query
   * @returns Playwright Locator
   */
  private executeTestingLibraryQuery(
    queryName: string,
    params: string[]
  ): Locator {
    switch (queryName.toLowerCase()) {
      case "getbyrole":
        // First param is role, second is name (optional)
        if (params.length > 1) {
          return this.page.getByRole(params[0] as any, { name: params[1] });
        }
        return this.page.getByRole(params[0] as any);

      case "getbytext":
        return this.page.getByText(params[0], { exact: false });

      case "getbylabeltext":
        return this.page.getByLabel(params[0]);

      case "getbyplaceholdertext":
        return this.page.getByPlaceholder(params[0]);

      case "getbytestid":
        return this.page.getByTestId(params[0]);

      case "getbyalttext":
        return this.page.getByAltText(params[0]);

      default:
        // Fallback to a basic text search if the query type is not recognized
        return this.page.getByText(params[0]);
    }
  }
}

// Helper function to create an A11yAILocator instance
export function createA11yAILocator(
  page: Page,
  testInfo: TestInfo,
  options?: {
    model?: string;
    baseUrl?: string;
    snapshotFilePath?: string;
    apiKey?: string;
    timeout?: number;
  }
): A11yAILocator {
  return new A11yAILocator(page, testInfo, options);
}
