import * as fs from "fs";
import * as path from "path";

/**
 * Class to manage saving and loading locator snapshots
 */
export class SnapshotManager {
  private snapshotFilePath: string | null;

  constructor(snapshotFilePath: string | null) {
    this.snapshotFilePath = snapshotFilePath;
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
