import { type Cid, cidForRawBytes, parseCid } from "@atproto/lex-data";
import type { CommitData } from "@atproto/repo";
import { BlockMap, ReadableBlockstore } from "@atproto/repo";
import { Octokit } from "octokit";

function toBase64(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
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
		try {
			const res = await this.octokit.rest.repos.getContent({
				owner: this.owner,
				repo: this.repo,
				path,
				ref: this.branch,
			});
			const data = res.data;
			if (!Array.isArray(data) && data.type === "file") {
				return {
					bytes: fromBase64(data.content.replace(/\n/g, "")),
					sha: data.sha,
				};
			} else return null;
		} catch {
			return null;
		}
	}

	private async putFile(path: string, bytes: Uint8Array, message: string) {
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
	}

	async getRoot(): Promise<Cid | null> {
		const file = await this.getFile("refs/root");
		if (!file) return null;
		return parseCid(new TextDecoder().decode(file.bytes).trim());
	}

	async updateRoot(cid: Cid, _rev: string): Promise<void> {
		await this.putFile(
			"refs/root",
			new TextEncoder().encode(cid.toString()),
			`root -> ${cid.toString()}`,
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

	async putBlock(cid: Cid, block: Uint8Array, _rev: string): Promise<void> {
		if (await this.has(cid)) return;
		await this.putFile(this.blockPath(cid), block, `put ${cid.toString()}`);
	}

	async putMany(blocks: BlockMap, rev: string): Promise<void> {
		for (const [cid, bytes] of blocks) await this.putBlock(cid, bytes, rev);
	}

	async applyCommit(commit: CommitData): Promise<void> {
		await this.putMany(commit.newBlocks, commit.rev);
		await this.updateRoot(commit.cid, commit.rev);
	}

	async putBlob(bytes: Uint8Array): Promise<Cid> {
		const cid = await cidForRawBytes(bytes);
		if (!(await this.has(cid))) {
			await this.putFile(
				this.blockPath(cid),
				bytes,
				`put blob ${cid.toString()}`,
			);
		}
		return cid;
	}
}
