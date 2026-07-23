import type { BlockMap, ReadonlyBlockStore } from "@atcute/mst";
import { exists } from "@std/fs";

export class LocalBlockStore implements ReadonlyBlockStore {
	constructor(readonly repoPath: string) {}

	async get(cid: string): Promise<Uint8Array<ArrayBuffer> | null> {
		const path = `${this.repoPath}/${cid}`;
		const fileExists = await exists(path, { isFile: true });
		if (!fileExists) return null;
		return new Uint8Array(await Deno.readFile(path));
	}

	async getMany(
		cids: string[],
	): Promise<{ found: BlockMap; missing: string[] }> {
		const found: BlockMap = new Map();
		const missing: string[] = [];
		for (const cid of cids) {
			const bytes = await this.get(cid);
			if (bytes) found.set(cid, bytes);
			else missing.push(cid);
		}
		return { found, missing };
	}

	async has(cid: string): Promise<boolean> {
		return (await this.get(cid)) !== null;
	}

	async getRoot(): Promise<string | null> {
		const path = `${this.repoPath}/refs/root`;
		const fileExists = await exists(path, { isFile: true });
		if (!fileExists) return null;
		return (await Deno.readTextFile(path)).trim();
	}

	async *iterAllBlocks(): AsyncIterable<{ cidStr: string; bytes: Uint8Array }> {
		const dirExists = await exists(this.repoPath, { isDirectory: true });
		if (!dirExists) return;
		for await (const entry of Deno.readDir(this.repoPath)) {
			if (!entry.isFile || entry.name === "refs") continue;
			const bytes = await Deno.readFile(`${this.repoPath}/${entry.name}`);
			yield { cidStr: entry.name, bytes };
		}
	}
}
