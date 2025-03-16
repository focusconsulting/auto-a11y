import { Page, Locator, TestInfo } from '@playwright/test';
import { Ollama } from 'ollama';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';

export class A11yAILocator {
  private page: Page;
  private ollama: Ollama | null = null;
  private anthropic: Anthropic | null = null;
  private model: string;
  private aiProvider: 'ollama' | 'anthropic';
  private snapshotFilePath: string | null = null;

  constructor(page: Page, testInfo: TestInfo, options: { 
    model?: string, 
    baseUrl?: string, 
    snapshotFilePath?: string,
    apiKey?: string 
  } = {}) {
    this.page = page;
    
    // Determine which AI provider to use based on the model
    if (options.model === 'claude-3-7' || options.model?.startsWith('claude-')) {
      this.aiProvider = 'anthropic';
      this.model = options.model || 'claude-3-7';
      this.anthropic = new Anthropic({
        apiKey: options.apiKey || process.env.ANTHROPIC_API_KEY || ''
      });
    } else {
      this.aiProvider = 'ollama';
      this.model = options.model || 'deep-seek-auto-a11y';
      this.ollama = new Ollama({
        host: options.baseUrl || 'http://localhost:11434'
      });
    }
    
    // Default to test name if available, otherwise use provided path or null
    if (options.snapshotFilePath) {
      this.snapshotFilePath = options.snapshotFilePath;
    } else {
      // Try to get test info from page context
      if (testInfo.title) {
        // Create snapshots directory if it doesn't exist
        const snapshotsDir = path.join(process.cwd(), 'locator-snapshots');
        if (!fs.existsSync(snapshotsDir)) {
          fs.mkdirSync(snapshotsDir, { recursive: true });
        }
        // Use test name for snapshot file
        this.snapshotFilePath = path.join(snapshotsDir, `${testInfo.title.replace(/\s+/g, '-')}.json`);
      } else {
        this.snapshotFilePath = null;
      }
    }
  }

  /**
   * Reads locator snapshots from the snapshot file
   * @returns Object containing saved locators or empty object if file doesn't exist
   */
  private readSnapshots(): Record<string, { queryName: string, params: string[] }> {
    if (!this.snapshotFilePath) return {};
    
    try {
      if (fs.existsSync(this.snapshotFilePath)) {
        const data = fs.readFileSync(this.snapshotFilePath, 'utf8');
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
  private saveSnapshot(description: string, queryInfo: { queryName: string, params: string[] }): void {
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
      fs.writeFileSync(this.snapshotFilePath, jsonString, 'utf8');
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
    const bodyContent = this.extractBodyContent(html);
    
    // Prepare the prompt for AI
    // AI! adjust the prompt for stricter priority order
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

Choose from these query types (in order of preference):
1. getByRole - when element has a specific ARIA role and accessible name
2. getByLabelText - for form elements with associated labels
3. getByPlaceholderText - for input elements with placeholder text
4. getByAltText - for images with alt text
5. getByText - CRITICAL INSTRUCTION:                    
  - You MUST provide the EXACT and COMPLETE text content 
of the element                                          
  - NEVER return partial text                          
  - Example: if element is <div>Yes, you can</div>,    
return "getByText: Yes, you can" (NOT just "Yes")       
  - Example: if element is <button>Submit form</button>, 
return "getByText: Submit form" (NOT just "Submit")     
  - ALWAYS include ALL text within the element 
6. getByTestId - when element has a data-testid attribute

Description: ${description}

HTML:
${bodyContent}
`;

    let queryInfo: string;

    // Get the query suggestion from the appropriate AI provider
    if (this.aiProvider === 'anthropic' && this.anthropic) {
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: "You must always return the COMPLETE text content for getByText queries, never partial matches. For example, if the element contains 'Yes, you can', you must return the entire text 'Yes, you can', not just 'Yes'.",
        messages: [{ role: 'user', content: prompt }]
      });
      queryInfo = response.content[0].text.trim();
    } else if (this.ollama) {
      const response = await this.ollama.chat({
        model: this.model,
        messages: [{ role: 'user', content: prompt }]
      });
      queryInfo = response.message.content.trim();
    } else {
      throw new Error('No AI provider configured');
    }
    const [queryName, ...params] = queryInfo.split(':').map(part => part.trim());
    
    // Handle parameters more carefully to avoid splitting text that contains commas
    let queryParams: string[] = [];
    
    // For getByText, we want to preserve the entire text including any commas
    if (queryName.toLowerCase() === 'getbytext') {
      queryParams = [params.join(':').trim()];
    } else {
      // For other query types, we can split by comma as they typically have separate parameters
      queryParams = params.join(':').split(',').map(p => p.trim());
    }
    
    // Save the snapshot for future use
    this.saveSnapshot(description, { queryName, params: queryParams });
    
    // Execute the appropriate Testing Library query
    return this.executeTestingLibraryQuery(queryName, queryParams);
  }

  
  /**
   * Extracts and sanitizes the body content from HTML
   * @param html The full HTML content
   * @returns Sanitized body content
   */
  private extractBodyContent(html: string): string {
    try {
      const $ = cheerio.load(html);
      
      // Remove scripts and styles
      $('script, style').remove();
      
      // Remove data attributes and classes
      $('*').each((_, el) => {
        const element = $(el);
        // Remove all data-* attributes except data-testid
        Object.keys(el.attribs || {})
          .filter(attr => attr.startsWith('data-') && attr !== 'data-testid')
          .forEach(attr => element.removeAttr(attr));
        
        // Remove class attributes
        element.removeAttr('class');
        
        // Remove other non-essential attributes
        ['id', 'style'].forEach(attr => element.removeAttr(attr));
      });
      
      // Get the body content or fall back to the entire document
      const bodyContent = $('body').html() || $.html();
      return bodyContent.trim();
    } catch (error) {
      console.warn(`Error extracting body content: ${error}`);
      return html;
    }
  }

  /**
   * Executes the appropriate Testing Library query based on the AI suggestion
   * @param queryName The name of the Testing Library query
   * @param params The parameters for the query
   * @returns Playwright Locator
   */
  private executeTestingLibraryQuery(queryName: string, params: string[]): Locator {
    switch(queryName.toLowerCase()) {
      case 'getbyrole':
        // First param is role, second is name (optional)
        if (params.length > 1) {
          return this.page.getByRole(params[0] as any, { name: params[1] });
        }
        return this.page.getByRole(params[0] as any);
        
      case 'getbytext':
        return this.page.getByText(params[0], {exact: false});
        
      case 'getbylabeltext':
        return this.page.getByLabel(params[0]);
        
      case 'getbyplaceholdertext':
        return this.page.getByPlaceholder(params[0]);
        
      case 'getbytestid':
        return this.page.getByTestId(params[0]);
        
      case 'getbyalttext':
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
    model?: string, 
    baseUrl?: string, 
    snapshotFilePath?: string,
    apiKey?: string 
  }
): A11yAILocator {
  return new A11yAILocator(page, testInfo, options);
}
