/**
 * Creates a prompt for AI to determine the most appropriate Testing Library query
 * @param description Human description of the element to find
 * @param bodyContent HTML content of the page
 * @returns Formatted prompt string
 */
export function createLocatorPrompt(description: string, bodyContent: string): string {
  return `
You are an expert in accessibility testing with Testing Library. Given the HTML below and a description of an element,
determine the most appropriate Testing Library query to locate that element.

Return ONLY a JSON object with the following format:
{"query": "queryName", "params": ["param1", "param2"]}

For example:
{"query": "getByRole", "params": ["button", "Submit"]}
{"query": "getByText", "params": ["Sign up now"]}
{"query": "getByLabelText", "params": ["Email address"]}
{"query": "getByPlaceholderText", "params": ["Enter your name"]}
{"query": "getByTestId", "params": ["login-form"]}

IMPORTANT: you must return only the JSON object and nothing else.

STRICT PRIORITY ORDER - You MUST follow this order when selecting a query type:

1. getByRole - HIGHEST PRIORITY
   - Use whenever possible if the element has a semantic role and accessible name
   - Examples: getByRole: button, Submit | getByRole: heading, Welcome | getByRole: checkbox, Accept terms
   - ONLY use with valid ARIA roles such as: alert, alertdialog, application, article, banner, button, cell, checkbox, columnheader, combobox, complementary, contentinfo, definition, dialog, directory, document, feed, figure, form, grid, gridcell, group, heading, img, link, list, listbox, listitem, log, main, marquee, math, menu, menubar, menuitem, meter, navigation, none, note, option, presentation, progressbar, radio, radiogroup, region, row, rowgroup, rowheader, scrollbar, search, searchbox, separator, slider, spinbutton, status, switch, tab, table, tablist, tabpanel, term, textbox, timer, toolbar, tooltip, tree, treegrid, treeitem
   - NEVER use with non-ARIA roles like "paragraph", "span", "div", etc.

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

Query:
`;
}
