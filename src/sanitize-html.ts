import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";

/**
 * Simplifies HTML by keeping only essential elements and attributes
 * @param html The HTML content to simplify
 * @returns Simplified HTML string
 */
export function simplifyHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
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
      "img",
    ],
    exclusiveFilter: (frame) => {
      // TODO: check how this function works
      return (frame.tag === "div" || frame.tag === "span")  && Object.keys(frame.attribs).includes("role")
    },
    allowedAttributes: {
      "*": ["checked", "aria-*", "name", "data-testid", "role", "region", "value"] 
    }
  });
}

/**
 * Extracts and sanitizes the body content from HTML
 * @param html The full HTML content
 * @param description The element description to help focus the extraction
 * @returns Sanitized body content
 */
export function extractBodyContent(
  html: string
): string {

  try {
    const cleaned = sanitizeHtml(html, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
      allowedAttributes: {
        "*": ["checked", "aria-*", "name", "data-testid", "role", "region", "value"] 
      }
    });
    const $ = cheerio.load(cleaned);

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

    // If no relevant elements found or context extraction failed,
    // get the body content and truncate if necessary
    let bodyContent = $("body").html() || $.html();

    if(bodyContent.length > 8192) {
      console.warn("Body content might be too large for the context window")
    }

    return bodyContent.trim();
  } catch (error) {
    console.warn(`Error extracting body content: ${error}`);
    return html.length > 20000
      ? html.substring(0, 10000) + "..." + html.substring(html.length - 10000)
      : html;
  }
}
