import * as CID from "@atcute/cid";
import type { BlockMap, ReadonlyBlockStore } from "@atcute/mst";
import { exists } from "@std/fs";

export class LocalBlockStore implements ReadonlyBlockStore {
	constructor(readonly repoPath: string) {}

	async get(cid: string): Promise<Uint8Array<ArrayBuffer> | null> {
		const result =
			(await this.findBlock(cid, this.repoPath)) ?? (await this.findBlob(cid));
		return result ? new Uint8Array(result) : null;
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

	async putBlob(bytes: Uint8Array): Promise<string> {
		const cid = await CID.create(CID.CODEC_RAW, bytes);
		const cidStr = CID.toString(cid);
		await Deno.mkdir(`${this.repoPath}/blobs`, { recursive: true });
		await Deno.writeFile(`${this.repoPath}/blobs/${cidStr}`, bytes);
		return cidStr;
	}

	async listBlobCids(): Promise<string[]> {
		const dir = `${this.repoPath}/blobs`;
		const dirExists = await exists(dir, { isDirectory: true });
		if (!dirExists) return [];
		const cids: string[] = [];
		for await (const entry of Deno.readDir(dir)) {
			if (entry.isFile) cids.push(entry.name);
		}
		return cids.sort();
	}

	async *iterAllBlocks(): AsyncIterable<{ cidStr: string; bytes: Uint8Array }> {
		yield* this.scanDir(this.repoPath);
	}

	private async *scanDir(
		dir: string,
	): AsyncIterable<{ cidStr: string; bytes: Uint8Array }> {
		const dirExists = await exists(dir, { isDirectory: true });
		if (!dirExists) return;
		for await (const entry of Deno.readDir(dir)) {
			if (entry.name === "refs" || entry.name === "blobs") continue;
			if (entry.isDirectory) {
				const underscorePath = `${dir}/${entry.name}/_`;
				const underscoreExists = await exists(underscorePath, { isFile: true });
				if (underscoreExists) {
					const bytes = await Deno.readFile(underscorePath);
					yield { cidStr: entry.name, bytes };
				}
				yield* this.scanDir(`${dir}/${entry.name}`);
			} else if (entry.name !== "_") {
				const bytes = await Deno.readFile(`${dir}/${entry.name}`);
				yield { cidStr: entry.name, bytes };
			}
		}
	}

	private async findBlock(
		cid: string,
		dir: string,
	): Promise<Uint8Array | null> {
		const flatPath = `${dir}/${cid}`;
		const flatExists = await exists(flatPath, { isFile: true });
		if (flatExists) return await Deno.readFile(flatPath);

		const nodePath = `${dir}/${cid}/_`;
		const nodeExists = await exists(nodePath, { isFile: true });
		if (nodeExists) return await Deno.readFile(nodePath);

		const dirExists = await exists(dir, { isDirectory: true });
		if (!dirExists) return null;
		for await (const entry of Deno.readDir(dir)) {
			if (!entry.isDirectory || entry.name === "refs" || entry.name === "blobs")
				continue;
			const found = await this.findBlock(cid, `${dir}/${entry.name}`);
			if (found) return found;
		}

		return null;
	}

	private async findBlob(cid: string): Promise<Uint8Array | null> {
		const path = `${this.repoPath}/blobs/${cid}`;
		const fileExists = await exists(path, { isFile: true });
		if (!fileExists) return null;
		return await Deno.readFile(path);
	}
}
