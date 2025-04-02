import { Page, Locator, TestInfo } from "@playwright/test";
import { Ollama } from "ollama";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} from "@google/generative-ai";

import { SnapshotManager } from "./snapshot-manager";
import {
  createLocatorPrompt,
  createSimpleLocatorPrompt,
  LocatorQuery,
  LocatorQuerySchema,
} from "./prompt";
import { extractBodyContent, simplifyHtml } from "./sanitize-html";
import zodToJsonSchema from "zod-to-json-schema";
import { zodToVertexSchema } from "@techery/zod-to-vertex-schema";

export class A11yAILocator {
  private page: Page;
  private ollama: Ollama | null = null;
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;
  private googleAI: GoogleGenerativeAI | null = null;
  private model: string;
  private aiProvider:
    | "ollama"
    | "anthropic"
    | "openai"
    | "gemini"
    | "deepseek"
    | "bedrock";
  private useSimplifiedHtml: boolean = false;
  private snapshotFilePath: string | null = null;
  private cachedBodyContent: string | null = null;
  private lastHtml: string | null = null;
  private timeout: number;
  private snapshotManager: SnapshotManager;
  private testInstance: any;

  constructor(
    page: Page,
    testInfo: TestInfo,
    options: {
      model?: string;
      provider:
        | "ollama"
        | "anthropic"
        | "openai"
        | "gemini"
        | "deepseek"
        | "bedrock";
      baseUrl?: string;
      snapshotFilePath?: string;
      apiKey?: string;
      timeout?: number;
      testInstance?: any;
      useSimplifiedHtml?: boolean;
    }
  ) {
    this.useSimplifiedHtml = options.useSimplifiedHtml || false;
    this.testInstance = options.testInstance || null;
    this.page = page;
    this.timeout = options.timeout || 60000; // Default 60 seconds
    this.aiProvider = options.provider;

    // Set default models based on provider if not specified
    if (!options.model) {
      switch (options.provider) {
        case "anthropic":
          this.model = "claude-3-haiku-20240307";
          break;
        case "openai":
          this.model = "gpt-4o-mini";
          break;
        case "gemini":
          this.model = "gemini-2.5-pro-exp-03-25";
          break;
        case "deepseek":
          this.model = "deepseek-chat";
          break;
        case "bedrock":
          throw new Error("Model must be specified for Bedrock provider");
        case "ollama":
          throw new Error("Model must be specified for Ollama provider");
        default:
          throw new Error(`Unknown provider: ${options.provider}`);
      }
    } else {
      this.model = options.model;
    }

    // Initialize the appropriate client based on the provider
    switch (this.aiProvider) {
      case "anthropic":
        const anthropicApiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
        if (!anthropicApiKey) {
          throw new Error(
            "Anthropic API key is required. Provide it via options.apiKey or ANTHROPIC_API_KEY environment variable."
          );
        }
        this.anthropic = new Anthropic({
          apiKey: anthropicApiKey,
        });
        break;
      case "openai":
        const openaiApiKey = options.apiKey || process.env.OPENAI_API_KEY;
        if (!openaiApiKey) {
          throw new Error(
            "OpenAI API key is required. Provide it via options.apiKey or OPENAI_API_KEY environment variable."
          );
        }
        this.openai = new OpenAI({
          apiKey: openaiApiKey,
          baseURL: options.baseUrl, // Allow overriding for Azure OpenAI etc.
        });
        break;
      case "gemini":
        const geminiApiKey = options.apiKey || process.env.GEMINI_API_KEY;
        if (!geminiApiKey) {
          throw new Error(
            "Gemini API key is required. Provide it via options.apiKey or GEMINI_API_KEY environment variable."
          );
        }
        this.googleAI = new GoogleGenerativeAI(geminiApiKey);
        break;
      case "deepseek":
        // DeepSeek uses OpenAI compatible API
        const deepseekApiKey = options.apiKey || process.env.DEEPSEEK_API_KEY;
        if (!deepseekApiKey) {
          throw new Error(
            "DeepSeek API key is required. Provide it via options.apiKey or DEEPSEEK_API_KEY environment variable."
          );
        }
        this.openai = new OpenAI({
          apiKey: deepseekApiKey,
          baseURL: options.baseUrl || "https://api.deepseek.com/v1", // Default DeepSeek API endpoint
        });
        break;
      case "bedrock":
        if (!options.model) {
          throw new Error("Model must be specified for Bedrock provider");
        }
        const bedrockApiKey = options.apiKey || process.env.AWS_ACCESS_KEY_ID;
        const bedrockSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
        if (!bedrockApiKey || !bedrockSecretKey) {
          throw new Error(
            "AWS credentials are required for Bedrock. Provide AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables."
          );
        }

        // Bedrock uses OpenAI compatible client
        this.openai = new OpenAI({
          apiKey: bedrockApiKey,
          baseURL:
            options.baseUrl ||
            `https://bedrock-runtime.us-east-1.amazonaws.com/model/${this.model}`,
        });
        break;
      case "ollama":
        if (!options.model) {
          throw new Error("Model must be specified for Ollama provider");
        }
        this.ollama = new Ollama({
          host: options.baseUrl || "http://localhost:11434", // Ollama host
        });
        break;
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

      const validSnapshotLocator: Locator | null = await this.testInstance.step(
        `auto-a11y: attempting to use locator snapshot: ${
          locatorQuery.query
        }, ${locatorQuery.params.join(",")}`,
        async () => {
          // Verify the locator exists on the page
          const count = await locator.count();
          if (count > 0) {
            return locator;
          } else {
            return null;
          }
        }
      );
      if (validSnapshotLocator) {
        return validSnapshotLocator;
      }
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
      const locatorQuery = this.testInstance
        ? await this.testInstance.step(
            `auto-a11y locating: ${description}`,
            async () => {
              // Make the AI request with timeout
              const queryInfo = await this.executePrompt(prompt, {
                useTimeout: true,
                timeoutPromise,
                systemPrompt:
                  "You must always return the COMPLETE text content for getByText queries, never partial matches. For example, if the element contains 'Yes, you can', you must return the entire text 'Yes, you can', not just 'Yes'.",
              });

              return LocatorQuerySchema.parse(JSON.parse(queryInfo));
            }
          )
        : // If no test instance is provided, execute without the step wrapper
          LocatorQuerySchema.parse(
            JSON.parse(
              await this.executePrompt(prompt, {
                useTimeout: true,
                timeoutPromise,
                systemPrompt:
                  "You must always return the COMPLETE text content for getByText queries, never partial matches. For example, if the element contains 'Yes, you can', you must return the entire text 'Yes, you can', not just 'Yes'.",
              })
            )
          );

      // Save the snapshot for future use
      this.snapshotManager.saveSnapshot(description, locatorQuery);

      // Execute the appropriate Testing Library query
      return this.executeTestingLibraryQuery(locatorQuery);
    } catch (error) {
      console.warn(
        `AI request failed or timed out: ${error}. Trying with simplified HTML...`
      );

      // If simplified HTML is enabled or the main approach failed
      if (this.useSimplifiedHtml || true) {
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
      } else {
        // If simplified HTML is disabled, just fall back to simple text search
        console.warn(
          `Simplified HTML is disabled. Falling back to simple text search for: "${description}"`
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
      systemPrompt: "Return only the query name and parameters. Be concise.",
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
    } = {}
  ): Promise<string> {
    if (this.aiProvider === "anthropic" && this.anthropic) {
      const responsePromise = this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1024,
        system:
          options.systemPrompt ||
          "Return only the query name and parameters. Be concise.",
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: "{" },
        ],
      });

      const response =
        options.useTimeout && options.timeoutPromise
          ? await Promise.race([responsePromise, options.timeoutPromise])
          : await responsePromise;

      const textContent = response.content.find((item) => item.type === "text");
      if (textContent && "text" in textContent) {
        return textContent.text.trim();
      } else {
        throw new Error("No text content found in Anthropic response");
      }
    } else if (this.aiProvider === "openai" && this.openai) {
      const responsePromise = this.openai.responses.create({
        model: this.model,
        text: {
          format: {
            type: "json_schema",
            name: "locatorQuerySchema",
            schema: zodToJsonSchema(LocatorQuerySchema)
          },
        },
        input: [
          {
            role: "system",
            content:
              options.systemPrompt ||
              "Return only the query name and parameters. Be concise.",
          },
          { role: "user", content: prompt },
          { role: "assistant", content: "{" },
        ],
      });

      const response =
        options.useTimeout && options.timeoutPromise
          ? await Promise.race([responsePromise, options.timeoutPromise])
          : await responsePromise;
      return response.output[0].type === "message" &&
        response.output[0].content[0].type === "output_text"
        ? response.output[0].content[0].text
        : "";
    } else if (this.aiProvider === "deepseek" && this.openai) {
      // DeepSeek uses OpenAI compatible API
      
      this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              options.systemPrompt ||
              "Return only the query name and parameters. Be concise.",
          },
          { role: "user", content: prompt },
          { role: "assistant", content: "{" },
        ],
        response_format: {type: "json_object"}
      })

      const responsePromise = this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              options.systemPrompt ||
              "Return only the query name and parameters. Be concise.",
          },
          { role: "user", content: prompt },
          { role: "assistant", content: "{" },
        ],
        response_format: {type: "json_object"}
      })
      

      const response =
        options.useTimeout && options.timeoutPromise
          ? await Promise.race([responsePromise, options.timeoutPromise])
          : await responsePromise;
        return response.choices[0]?.message?.content || ""
        
    } else if (this.aiProvider === "gemini" && this.googleAI) {
      const genAI = this.googleAI;
      const model = genAI.getGenerativeModel({
        model: this.model,
        safetySettings: [
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
        ],
      });

      const responsePromise = model.generateContent({
        contents: [
          { role: "user", parts: [{ text: prompt }] },
          { role: "model", parts: [{ text: "{" }] },
        ],
        generationConfig: {
          responseMimeType: "application/json",
        },
      });

      const response =
        options.useTimeout && options.timeoutPromise
          ? await Promise.race([responsePromise, options.timeoutPromise])
          : await responsePromise;
      console.log(response.response.text().trim());
      return response.response.text().trim();
    } else if (this.ollama) {
      const responsePromise = this.ollama.chat({
        model: this.model,
        format: zodToJsonSchema(LocatorQuerySchema) as string,
        options: {
          num_ctx: 8192,
        },
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: "{" },
        ],
      });

      const response =
        options.useTimeout && options.timeoutPromise
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
  private executeTestingLibraryQuery(query: LocatorQuery): Locator {
    switch (query.query.toLowerCase()) {
      case "getbyrole":
        // First param is role, second is name (optional)
        if (query.params.length > 1) {
          return this.page.getByRole(query.params[0] as any, {
            name: query.params[1],
          });
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
  testInstance: any,
  options: {
    model?: string;
    provider:
      | "ollama"
      | "anthropic"
      | "openai"
      | "gemini"
      | "deepseek"
      | "bedrock";
    baseUrl?: string;
    snapshotFilePath?: string;
    apiKey?: string;
    timeout?: number;
    useSimplifiedHtml?: boolean;
  }
): A11yAILocator {
  return new A11yAILocator(page, testInfo, { ...options, testInstance });
}
