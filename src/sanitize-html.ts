import * as cheerio from "cheerio";

/**
 * Extracts and sanitizes the body content from HTML
 * @param html The full HTML content
 * @param description The element description to help focus the extraction
 * @returns Sanitized body content
 */
export function extractBodyContent(html: string, description: string): string {
  try {
    const $ = cheerio.load(html);

    // Remove scripts, styles, SVGs, and inline images
    $("script, style, svg").remove();
    $("img[src^='data:']").remove();

    // Simplify deeply nested structures
    $("div > div:only-child").each((_, el) => {
      const $el = $(el);
      const $parent = $el.parent();
      if (
        $parent.children().length === 1 &&
        !$el.is("button, a, input, select, textarea")
      ) {
        // Replace the parent with its children
        const $children = $el.children();
        $el.replaceWith($children);
      }
    });

    // Remove empty containers
    $("div:empty, span:empty").remove();

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
