import * as fs from "fs";
import * as path from "path";
import { TestInfo } from "@playwright/test";

/**
 * Class to manage saving and loading locator snapshots
 */
export class SnapshotManager {
  private snapshotFilePath: string | null;

  constructor(snapshotFilePath: string | null) {
    this.snapshotFilePath = snapshotFilePath;
  }

  /**
   * Creates a snapshot file path based on test information
   * @param testInfo Playwright TestInfo object
   * @returns Path to the snapshot file
   */
  static createSnapshotPath(testInfo: TestInfo): string {
    // Get the test file path and create a snapshot directory next to it
    const testFilePath = testInfo.file;
    const testDir = path.dirname(testFilePath);
    const testFileName = path.basename(
      testFilePath,
      path.extname(testFilePath)
    );

    // Create snapshots directory if it doesn't exist
    const snapshotsDir = path.join(
      testDir,
      `__${testFileName}-locator-snapshots__`
    );
    if (!fs.existsSync(snapshotsDir)) {
      fs.mkdirSync(snapshotsDir, { recursive: true });
    }

    // Use test name for snapshot file
    return path.join(
      snapshotsDir,
      `${testInfo.title.replace(/\s+/g, "-")}.json`
    );
  }

  /**
   * Reads locator snapshots from the snapshot file
   * @returns Object containing saved locators or empty object if file doesn't exist
   */
  readSnapshots(): Record<
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
  saveSnapshot(
    description: string,
    // AI! the type of query info needs to be the same as zod schema LocatorQuerySchema
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
}
