import { z } from "zod";

/**
 * Zod schema for the locator query response from AI
 */
export const LocatorQuerySchema = z.object({
  query: z.enum([
    "getByRole",
    "getByLabelText",
    "getByPlaceholderText",
    "getByAltText",
    "getByText",
    "getByTestId"
  ]),
  params: z.array(z.string()).min(1)
});

/**
 * Type for the locator query response
 */
export type LocatorQuery = z.infer<typeof LocatorQuerySchema>;
