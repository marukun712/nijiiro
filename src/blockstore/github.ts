import { type Cid, cidForRawBytes, parseCid } from "@atproto/lex-data";
import type { CommitData } from "@atproto/repo";
import { BlockMap, ReadableBlockstore } from "@atproto/repo";
import { encodeBase64 } from "@std/encoding";
import { Octokit } from "octokit";
import { z } from "zod";

const httpErrorSchema = z.object({ status: z.number() });

function toBase64(bytes: Uint8Array): string {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return encodeBase64(copy);
}

export class GitHubRepoStorage extends ReadableBlockstore {
	octokit: Octokit;
	owner: string;
	repo: string;
	branch: string;

	constructor(token: string, owner: string, repo: string, branch = "main") {
		super();
		this.octokit = new Octokit({ auth: token });
		this.owner = owner;
		this.repo = repo;
		this.branch = branch;
	}

	private blockPath(cid: Cid) {
		return `blocks/${cid.toString()}`;
	}

	private async getFile(path: string) {
		console.log("[github] getFile:", path);
		try {
			const res = await this.octokit.rest.repos.getContent({
				owner: this.owner,
				repo: this.repo,
				path,
				ref: this.branch,
			});
			console.log("[github] getFile ok:", path);
			const data = res.data;
			if (!Array.isArray(data) && data.type === "file" && data.download_url) {
				const raw = await fetch(data.download_url);
				const bytes = new Uint8Array(await raw.arrayBuffer());
				return {
					bytes: bytes,
					sha: data.sha,
				};
			} else return null;
		} catch (err) {
			const parsed = httpErrorSchema.safeParse(err);
			if (parsed.success && parsed.data.status !== 404) {
				console.log("[github] getFile error:", path, err);
			}
			return null;
		}
	}

	private async putFile(path: string, bytes: Uint8Array, message: string) {
		console.log("[github] putFile:", path, `(${bytes.length} bytes)`);
		const existing = await this.getFile(path);
		await this.octokit.rest.repos.createOrUpdateFileContents({
			owner: this.owner,
			repo: this.repo,
			path,
			message,
			content: toBase64(bytes),
			sha: existing?.sha,
			branch: this.branch,
		});
		console.log("[github] putFile done:", path);
	}

	async getRoot(): Promise<Cid | null> {
		console.log("[github] getRoot");
		const file = await this.getFile("refs/root");
		if (!file) {
			console.log("[github] getRoot: no root found");
			return null;
		}
		const cid = parseCid(new TextDecoder().decode(file.bytes).trim());
		console.log("[github] getRoot:", cid.toString());
		return cid;
	}

	async updateRoot(cid: Cid): Promise<void> {
		console.log("[github] updateRoot:", cid.toString());
		await this.putFile(
			"refs/root",
			new TextEncoder().encode(cid.toString()),
			`root -> ${cid.toString()}`,
		);
	}

	async getSeq(): Promise<number> {
		const file = await this.getFile("refs/seq");
		if (!file) return 0;
		return Number(new TextDecoder().decode(file.bytes).trim());
	}

	async updateSeq(seq: number): Promise<void> {
		console.log("[github] updateSeq:", seq);
		await this.putFile(
			"refs/seq",
			new TextEncoder().encode(String(seq)),
			`seq -> ${seq}`,
		);
	}

	async getBytes(cid: Cid): Promise<Uint8Array | null> {
		const file = await this.getFile(this.blockPath(cid));
		return file ? file.bytes : null;
	}

	async has(cid: Cid): Promise<boolean> {
		return (await this.getBytes(cid)) !== null;
	}

	async getBlocks(cids: Cid[]) {
		const blocks = new BlockMap();
		const missing: Cid[] = [];
		for (const cid of cids) {
			const bytes = await this.getBytes(cid);
			if (bytes) blocks.set(cid, bytes);
			else missing.push(cid);
		}
		return { blocks, missing };
	}

	async putBlock(cid: Cid, block: Uint8Array): Promise<void> {
		if (await this.has(cid)) {
			console.log(
				"[github] putBlock skipped (already exists):",
				cid.toString(),
			);
			return;
		}
		console.log("[github] putBlock:", cid.toString());
		await this.putFile(this.blockPath(cid), block, `put ${cid.toString()}`);
	}

	async putMany(blocks: BlockMap): Promise<void> {
		for (const [cid, bytes] of blocks) await this.putBlock(cid, bytes);
	}

	async applyCommit(commit: CommitData): Promise<void> {
		await this.putMany(commit.newBlocks);
		await this.updateRoot(commit.cid);
	}

	async putBlob(bytes: Uint8Array): Promise<Cid> {
		const cid = await cidForRawBytes(bytes);
		if (!(await this.has(cid))) {
			console.log(
				"[github] putBlob:",
				cid.toString(),
				`(${bytes.length} bytes)`,
			);
			await this.putFile(
				this.blockPath(cid),
				bytes,
				`put blob ${cid.toString()}`,
			);
		} else {
			console.log("[github] putBlob skipped (already exists):", cid.toString());
		}
		return cid;
	}
}
