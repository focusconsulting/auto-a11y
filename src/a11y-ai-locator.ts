import { Page, Locator, TestInfo } from "@playwright/test";
import { Ollama } from "ollama";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";
import { SnapshotManager } from "./snapshot-manager";
import { createLocatorPrompt, createSimpleLocatorPrompt, LocatorQuery, LocatorQuerySchema } from "./prompt";
import { extractBodyContent, simplifyHtml } from "./sanitize-html";
import zodToJsonSchema from "zod-to-json-schema";

export class A11yAILocator {
  private page: Page;
  private ollama: Ollama | null = null;
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;
  private googleAI: GoogleGenerativeAI | null = null;
  private model: string;
  private aiProvider: "ollama" | "anthropic" | "openai" | "gemini" | "deepseek";
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
    this.timeout = options.timeout || 60000; // Default 60 seconds

    // Determine which AI provider to use based on the model and options
    this.model = options.model || "deep-seek-auto-a11y"; // Default model

    if (this.model.startsWith("claude-")) {
      this.aiProvider = "anthropic";
      this.anthropic = new Anthropic({
        apiKey: options.apiKey || process.env.ANTHROPIC_API_KEY || "",
      });
    } else if (this.model.startsWith("gpt-")) {
      this.aiProvider = "openai";
      this.openai = new OpenAI({
        apiKey: options.apiKey || process.env.OPENAI_API_KEY || "",
        baseURL: options.baseUrl, // Allow overriding for Azure OpenAI etc.
      });
    } else if (this.model.startsWith("gemini-")) {
      this.aiProvider = "gemini";
      const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("Gemini API key is required. Provide it via options.apiKey or GEMINI_API_KEY environment variable.");
      }
      this.googleAI = new GoogleGenerativeAI(apiKey);
    } else if (this.model.startsWith("deepseek-")) {
       this.aiProvider = "deepseek";
       // DeepSeek uses OpenAI compatible API
       this.openai = new OpenAI({
         apiKey: options.apiKey || process.env.DEEPSEEK_API_KEY || "",
         baseURL: options.baseUrl || "https://api.deepseek.com/v1", // Default DeepSeek API endpoint
       });
    } else {
      // Default to Ollama if no specific provider prefix matches or if an Ollama model name is given
      this.aiProvider = "ollama";
      this.ollama = new Ollama({
        host: options.baseUrl || "http://localhost:11434", // Ollama host
      });
      // If a model name was provided but didn't match others, assume it's for Ollama
      this.model = options.model || "deep-seek-auto-a11y"; // Keep or set Ollama model
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
      const locatorQuery = snapshots[description];
      const locator = this.executeTestingLibraryQuery(locatorQuery);

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
      const queryInfo = await this.executePrompt(prompt, {
        useTimeout: true,
        timeoutPromise,
        systemPrompt: "You must always return the COMPLETE text content for getByText queries, never partial matches. For example, if the element contains 'Yes, you can', you must return the entire text 'Yes, you can', not just 'Yes'.",
        format: zodToJsonSchema(LocatorQuerySchema) as string
      });

      const locatorQuery = LocatorQuerySchema.parse(JSON.parse(queryInfo));

      

      // Save the snapshot for future use
      this.snapshotManager.saveSnapshot(description, locatorQuery);

      // Execute the appropriate Testing Library query
      return this.executeTestingLibraryQuery(locatorQuery);
    } catch (error) {
      console.warn(
        `AI request failed or timed out: ${error}. Trying with simplified HTML...`
      );

      // Fall back to simplified HTML approach
      try {
        const locatorQuery = await this.locateWithSimplifiedHTML(
          description,
          html
        );

        // Save the snapshot for future use
        this.snapshotManager.saveSnapshot(description, locatorQuery);

        // Execute the appropriate Testing Library query
        return this.executeTestingLibraryQuery(locatorQuery);
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
  ): Promise<LocatorQuery> {
    // Create a much more simplified version of the HTML
    const simplifiedHTML = simplifyHtml(html);

    // Create a simplified prompt
    const prompt = createSimpleLocatorPrompt(description, simplifiedHTML);

    // Get the query suggestion from the appropriate AI provider
    const queryInfo = await this.executePrompt(prompt, {
      systemPrompt: "Return only the query name and parameters. Be concise."
    });

    const locatorQuery = LocatorQuerySchema.parse(JSON.parse(queryInfo));

    return locatorQuery;
  }

  /**
   * Executes a prompt against the configured AI provider
   * @param prompt The prompt to send to the AI
   * @param options Additional options for the AI request
   * @returns The AI response as a string
   */
  private async executePrompt(
    prompt: string, 
    options: {
      useTimeout?: boolean;
      timeoutPromise?: Promise<never>;
      systemPrompt?: string;
      format?: string;
    } = {}
  ): Promise<string> {
    // AI! I want to support OpenAI, DeepSeek and Gemini in addition to anthropic and ollama and they should use the same parameters as much as possible
    if (this.aiProvider === "anthropic" && this.anthropic) {
      const responsePromise = this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: options.systemPrompt || "Return only the query name and parameters. Be concise.",
        messages: [
          { role: "user", content: prompt }, 
          { role: "assistant", content: "{" }
        ],
      });

      const response = options.useTimeout && options.timeoutPromise
        ? await Promise.race([responsePromise, options.timeoutPromise])
        : await responsePromise;

      const textContent = response.content.find(
        (item) => item.type === "text"
      );
      if (textContent && "text" in textContent) {
        return textContent.text.trim();
      } else {
        throw new Error("No text content found in Anthropic response");
      }
    } else if (this.ollama) {
      const responsePromise = this.ollama.chat({
        model: this.model,
        format: options.format,
        options: {
          num_ctx: 8192
        },
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: "{" }
        ],
      });

      const response = options.useTimeout && options.timeoutPromise
        ? await Promise.race([responsePromise, options.timeoutPromise])
        : await responsePromise;
        
      return response.message.content.trim();
    } else {
      throw new Error("No AI provider configured");
    }
  }

  /**
   * Executes the appropriate Testing Library query based on the AI suggestion
   * @param queryName The name of the Testing Library query
   * @param params The parameters for the query
   * @returns Playwright Locator
   */
  private executeTestingLibraryQuery(
    query: LocatorQuery
  ): Locator {
    switch (query.query.toLowerCase()) {
      case "getbyrole":
        // First param is role, second is name (optional)
        if (query.params.length > 1) {
          return this.page.getByRole(query.params[0] as any, { name: query.params[1] });
        }
        return this.page.getByRole(query.params[0] as any);

      case "getbytext":
        return this.page.getByText(query.params[0], { exact: false });

      case "getbylabeltext":
        return this.page.getByLabel(query.params[0]);

      case "getbyplaceholdertext":
        return this.page.getByPlaceholder(query.params[0]);

      case "getbytestid":
        return this.page.getByTestId(query.params[0]);

      case "getbyalttext":
        return this.page.getByAltText(query.params[0]);

      default:
        // Fallback to a basic text search if the query type is not recognized
        return this.page.getByText(query.params[0]);
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
