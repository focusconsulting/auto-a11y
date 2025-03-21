import { Page, Locator, TestInfo } from "@playwright/test";
import { Ollama } from "ollama";
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";

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
    this.timeout = options.timeout || 30000; // Default 30 seconds

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
      // Try to get test info from page context
      if (testInfo.title) {
        // Create snapshots directory if it doesn't exist
        // AI! update this so the snapshots are created in the directory of the test and with the name of the test so example.spec.ts should be __example-locator-snapshots__
        const snapshotsDir = path.join(process.cwd(), "locator-snapshots");
        if (!fs.existsSync(snapshotsDir)) {
          fs.mkdirSync(snapshotsDir, { recursive: true });
        }
        // Use test name for snapshot file
        this.snapshotFilePath = path.join(
          snapshotsDir,
          `${testInfo.title.replace(/\s+/g, "-")}.json`
        );
      } else {
        this.snapshotFilePath = null;
      }
    }
  }

  /**
   * Reads locator snapshots from the snapshot file
   * @returns Object containing saved locators or empty object if file doesn't exist
   */
  private readSnapshots(): Record<
    string,
    { queryName: string; params: string[] }
  > {
    if (!this.snapshotFilePath) return {};

    try {
      if (fs.existsSync(this.snapshotFilePath)) {
        const data = fs.readFileSync(this.snapshotFilePath, "utf8");
        return JSON.parse(data);
      }
    } catch (error) {
      console.warn(`Failed to read locator snapshots: ${error}`);
    }

    return {};
  }

  /**
   * Saves a locator to the snapshot file
   * @param description The element description
   * @param queryInfo The query information to save
   */
  private saveSnapshot(
    description: string,
    queryInfo: { queryName: string; params: string[] }
  ): void {
    if (!this.snapshotFilePath) return;

    try {
      // Ensure directory exists
      const dir = path.dirname(this.snapshotFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Read existing snapshots
      const snapshots = this.readSnapshots();

      // Add or update the snapshot
      snapshots[description] = queryInfo;

      // Write back to file with a replacer function to avoid escaping single quotes
      const jsonString = JSON.stringify(snapshots, null, 2);
      fs.writeFileSync(this.snapshotFilePath, jsonString, "utf8");
    } catch (error) {
      console.warn(`Failed to save locator snapshot: ${error}`);
    }
  }

  /**
   * Creates a locator using AI to determine the best Testing Library query
   * @param description Human description of the element to find
   * @returns Playwright Locator for the element
   */
  async locate(description: string): Promise<Locator> {
    // Check if we have a saved snapshot for this description
    const snapshots = this.readSnapshots();
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
      bodyContent = this.extractBodyContent(html, description);
      // Cache the results
      this.lastHtml = html;
      this.cachedBodyContent = bodyContent;
    }

    const prompt = `
You are an expert in accessibility testing with Testing Library. Given the HTML below and a description of an element,
determine the most appropriate Testing Library query to locate that element.

Return ONLY the query name and parameters in this format:
queryName: parameter

For example:
getByRole: button, Submit
getByText: Sign up now
getByLabelText: Email address
getByPlaceholderText: Enter your name
getByTestId: login-form

STRICT PRIORITY ORDER - You MUST follow this order when selecting a query type:

1. getByRole - HIGHEST PRIORITY
   - Use whenever possible if the element has a semantic role and accessible name
   - Examples: getByRole: button, Submit | getByRole: heading, Welcome | getByRole: checkbox, Accept terms
   - Check for roles like: button, link, heading, checkbox, radio, textbox, combobox, listbox, etc.

2. getByLabelText - HIGH PRIORITY
   - For form elements with associated labels
   - Example: getByLabelText: Email address

3. getByPlaceholderText
   - For input elements with placeholder text
   - Example: getByPlaceholderText: Enter your name

4. getByAltText
   - For images with alt text
   - Example: getByAltText: Company logo

5. getByText - LOWER PRIORITY
   - Only use when options 1-4 are not applicable
   - CRITICAL INSTRUCTION:                    
     - You MUST provide the EXACT and COMPLETE text content of the element                                          
     - NEVER return partial text                          
     - Example: if element is <div>Yes, you can</div>, return "getByText: Yes, you can" (NOT just "Yes")       
     - Example: if element is <button>Submit form</button>, return "getByText: Submit form" (NOT just "Submit")     
     - ALWAYS include ALL text within the element 

6. getByTestId - LOWEST PRIORITY
   - Only use as a last resort when no other query would work
   - Example: getByTestId: login-form

Description: ${description}

HTML:
${bodyContent}
`;

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

      // Save the snapshot for future use
      this.saveSnapshot(description, { queryName, params: queryParams });

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
        this.saveSnapshot(description, { queryName, params });

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
   * Extracts and sanitizes the body content from HTML
   * @param html The full HTML content
   * @param description The element description to help focus the extraction
   * @returns Sanitized body content
   */
  private extractBodyContent(html: string, description: string): string {
    try {
      const $ = cheerio.load(html);

      // Remove scripts and styles
      $("script, style").remove();

      // Remove data attributes and classes
      $("*").each((_, el) => {
        const element = $(el);
        // Remove all data-* attributes except data-testid
        Object.keys(element.attr())
          .filter((attr) => attr.startsWith("data-") && attr !== "data-testid")
          .forEach((attr) => element.removeAttr(attr));

        // Remove class attributes
        element.removeAttr("class");

        // Remove other non-essential attributes
        ["id", "style"].forEach((attr) => element.removeAttr(attr));
      });

      // Try to find elements that might match the description
      const searchTerms = description.toLowerCase().split(/\s+/);
      let relevantElements: cheerio.Cheerio = $("");

      // Look for elements containing text similar to the description
      $("body *").each((_, el) => {
        const text = $(el).text().toLowerCase();
        if (searchTerms.some((term) => text.includes(term))) {
          relevantElements = relevantElements.add(el);
        }
      });

      // If we found relevant elements, include them and their context
      if (relevantElements.length > 0) {
        let contextHTML = "";
        relevantElements.each((_, el) => {
          // Get the element and its parent context (up to 2 levels)
          const element = $(el);
          const parent = element.parent();
          const grandparent = parent.parent();

          // Add the grandparent's HTML if it's not too large
          const grandparentHtml = grandparent.html();
          const parentHtml = parent.html();

          if (grandparentHtml && grandparentHtml.length < 5000) {
            contextHTML +=
              grandparent.clone().wrap("<div>").parent().html() + "\n";
          } else if (parentHtml && parentHtml.length < 5000) {
            contextHTML += parent.clone().wrap("<div>").parent().html() + "\n";
          } else {
            contextHTML += element.clone().wrap("<div>").parent().html() + "\n";
          }
        });

        // If we have context HTML, return it (with deduplication)
        if (contextHTML) {
          // Simple deduplication by converting to a Set and back
          const lines = [...new Set(contextHTML.split("\n"))];
          return lines.join("\n").trim();
        }
      }

      // If no relevant elements found or context extraction failed,
      // get the body content and truncate if necessary
      let bodyContent = $("body").html() || $.html();

      // Truncate if too large (keep first and last parts which often contain important UI elements)
      const maxLength = 15000; // Adjust based on your model's context window
      if (bodyContent.length > maxLength) {
        const firstPart = bodyContent.substring(0, maxLength / 2);
        const lastPart = bodyContent.substring(
          bodyContent.length - maxLength / 2
        );
        bodyContent = firstPart + "\n...[content truncated]...\n" + lastPart;
      }

      return bodyContent.trim();
    } catch (error) {
      console.warn(`Error extracting body content: ${error}`);
      return html.length > 20000
        ? html.substring(0, 10000) + "..." + html.substring(html.length - 10000)
        : html;
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
    const prompt = `
Find the most appropriate Testing Library query for this element: "${description}"

Return ONLY the query name and parameters in this format:
queryName: parameter

Priority order: getByRole (highest), getByLabelText, getByPlaceholderText, getByAltText, getByText, getByTestId (lowest)

HTML:
${simplifiedHTML}
`;

    // Get the query suggestion from the appropriate AI provider
    let queryInfo: string;
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
