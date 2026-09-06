import { describe, expect, it } from "bun:test";

export class BundleCacheManager {
  private cachedContent: string | null = null;
  public buildCount = 0;

  async getBundle(): Promise<string> {
    if (this.cachedContent !== null) {
      return this.cachedContent;
    }
    // Simulate compilation
    this.buildCount++;
    this.cachedContent = `/* compiled-bundle-v${this.buildCount} */`;
    return this.cachedContent;
  }

  invalidate() {
    this.cachedContent = null;
  }
}

describe("HTTP Frontend Bundle Cache", () => {
  it("compiles bundle once and serves subsequent requests from memory cache", async () => {
    const manager = new BundleCacheManager();

    // 1st request triggers build
    const res1 = await manager.getBundle();
    expect(res1).toBe("/* compiled-bundle-v1 */");
    expect(manager.buildCount).toBe(1);

    // Concurrent requests serve from cache
    const [res2, res3, res4] = await Promise.all([
      manager.getBundle(),
      manager.getBundle(),
      manager.getBundle(),
    ]);

    expect(res2).toBe("/* compiled-bundle-v1 */");
    expect(res3).toBe("/* compiled-bundle-v1 */");
    expect(res4).toBe("/* compiled-bundle-v1 */");
    expect(manager.buildCount).toBe(1); // No new builds!

    // Invalidation triggers a single new build on next request
    manager.invalidate();
    const res5 = await manager.getBundle();
    expect(res5).toBe("/* compiled-bundle-v2 */");
    expect(manager.buildCount).toBe(2);
  });
});
