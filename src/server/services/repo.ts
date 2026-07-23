import { writeCarStream } from "@atcute/car";
import { decode } from "@atcute/cbor";
import type { CidLink } from "@atcute/cid";
import * as CID from "@atcute/cid";
import { isCid, isNsid, isRecordKey } from "@atcute/lexicons/syntax";
import {
	MemoryBlockStore,
	NodeStore,
	NodeWalker,
	OverlayBlockStore,
} from "@atcute/mst";
import type { Commit } from "@atcute/repo";
import { isCommit } from "@atcute/repo";
import { InternalServerError } from "@atcute/xrpc-server";
import { z } from "zod";

const recordSchema = z.record(z.string(), z.unknown());

import type { LocalBlockStore } from "../../blockstore/local.ts";
import { build } from "../../build.ts";
import { getBlob, listBlobCids, putBlob } from "../../store/blob.ts";
import { removeRecord, writeRecord } from "../../store/json.ts";
import type { CommitData, CommitOp } from "./firehose.ts";

export type RepoContext = {
	storage: LocalBlockStore;
	commit: Commit;
	rootCid: string;
};

export type WriteOp =
	| { action: "create"; collection: string; rkey: string; value: unknown }
	| { action: "update"; collection: string; rkey: string; value: unknown }
	| { action: "delete"; collection: string; rkey: string };

export type WriteResult = {
	uri: string;
	cid: string;
	commit: { cid: string; rev: string };
};

export type ApplyWriteItem =
	| { type: "create" | "update"; uri: string; cid: string }
	| { type: "delete" };

export type ApplyWritesResult = {
	commit: { cid: string; rev: string };
	items: ApplyWriteItem[];
};

export type RecordEntry = {
	uri: string;
	cid: string;
	value: Record<string, unknown>;
};

export class RepoService {
	onCommit?: (data: CommitData) => void;

	constructor(private ctx: RepoContext) {}

	get did(): string {
		return this.ctx.commit.did;
	}

	get commitCid(): string {
		return this.ctx.rootCid;
	}

	get commitRev(): string {
		return this.ctx.commit.rev;
	}

	private requireNsid(collection: string): void {
		if (!isNsid(collection)) {
			throw new InternalServerError({
				message: `invalid collection nsid: ${collection}`,
			});
		}
	}

	private requireRkey(rkey: string): void {
		if (!isRecordKey(rkey)) {
			throw new InternalServerError({ message: `invalid rkey: ${rkey}` });
		}
	}

	private requireCidLink(link: CidLink | null, key: string): CidLink {
		if (!link) {
			throw new InternalServerError({
				message: `missing block for key: ${key}`,
			});
		}
		return link;
	}

	private toUri(collection: string, rkey: string): string {
		return `at://${this.ctx.commit.did}/${collection}/${rkey}`;
	}

	private nodeStore(): NodeStore {
		return new NodeStore(
			new OverlayBlockStore(new MemoryBlockStore(), this.ctx.storage),
		);
	}

	private async snapshotCids(): Promise<Set<string>> {
		const cids = new Set<string>();
		for await (const { cidStr } of this.ctx.storage.iterAllBlocks()) {
			cids.add(cidStr);
		}
		return cids;
	}

	private computeDiffCar(oldCids: Set<string>): Promise<Uint8Array> {
		const rootCid = this.ctx.rootCid;
		const storage = this.ctx.storage;
		async function* diffBlocks() {
			for await (const { cidStr, bytes } of storage.iterAllBlocks()) {
				if (!oldCids.has(cidStr)) {
					yield { cid: CID.fromString(cidStr).bytes, data: bytes };
				}
			}
		}
		return collectStream(writeCarStream([{ $link: rootCid }], diffBlocks()));
	}

	async getSyncCarBytes(): Promise<Uint8Array> {
		const rootCid = this.ctx.rootCid;
		const commitBytes = await this.ctx.storage.get(rootCid);
		if (!commitBytes) {
			throw new InternalServerError({ message: "commit block missing" });
		}
		async function* blocks() {
			yield {
				cid: CID.fromString(rootCid).bytes,
				data: commitBytes as Uint8Array,
			};
		}
		return collectStream(writeCarStream([{ $link: rootCid }], blocks()));
	}

	private async rebuild(): Promise<void> {
		await build(false);
		const rootCid = await this.ctx.storage.getRoot();
		if (!rootCid) {
			throw new InternalServerError({ message: "no root after build" });
		}
		const rootBytes = await this.ctx.storage.get(rootCid);
		if (!rootBytes) {
			throw new InternalServerError({
				message: "missing commit block after build",
			});
		}
		const decoded = decode(rootBytes);
		if (!isCommit(decoded)) {
			throw new InternalServerError({ message: "invalid commit after build" });
		}
		this.ctx.rootCid = rootCid;
		this.ctx.commit = decoded;
	}

	async createRecord(
		collection: string,
		rkey: string,
		record: unknown,
	): Promise<WriteResult> {
		this.requireNsid(collection);
		this.requireRkey(rkey);
		const parsed = recordSchema.safeParse(record);
		if (!parsed.success) {
			throw new InternalServerError({ message: "record must be an object" });
		}
		await writeRecord(collection, rkey, parsed.data);
		const since = this.commitRev;
		const prevData = this.ctx.commit.data.$link;
		const oldCids = await this.snapshotCids();
		await this.rebuild();
		const walker = await NodeWalker.create(
			this.nodeStore(),
			this.ctx.commit.data.$link,
		);
		const cidLink = await walker.findRpath(`${collection}/${rkey}`);
		const newCid = this.requireCidLink(cidLink, `${collection}/${rkey}`).$link;
		const diffCar = await this.computeDiffCar(oldCids);
		this.onCommit?.({
			did: this.ctx.commit.did,
			rev: this.ctx.commit.rev,
			since,
			commitCid: this.ctx.rootCid,
			diffCar,
			ops: [{ action: "create", path: `${collection}/${rkey}`, cid: newCid }],
			prevData,
		});
		return {
			uri: this.toUri(collection, rkey),
			cid: newCid,
			commit: { cid: this.commitCid, rev: this.commitRev },
		};
	}

	async putRecord(
		collection: string,
		rkey: string,
		record: unknown,
	): Promise<WriteResult> {
		this.requireNsid(collection);
		this.requireRkey(rkey);
		const parsed = recordSchema.safeParse(record);
		if (!parsed.success) {
			throw new InternalServerError({ message: "record must be an object" });
		}
		const existing = await this.getRecord(collection, rkey);
		const action = existing ? "update" : "create";
		const prev = existing?.cid;
		await writeRecord(collection, rkey, parsed.data);
		const since = this.commitRev;
		const prevData = this.ctx.commit.data.$link;
		const oldCids = await this.snapshotCids();
		await this.rebuild();
		const walker = await NodeWalker.create(
			this.nodeStore(),
			this.ctx.commit.data.$link,
		);
		const cidLink = await walker.findRpath(`${collection}/${rkey}`);
		const newCid = this.requireCidLink(cidLink, `${collection}/${rkey}`).$link;
		const diffCar = await this.computeDiffCar(oldCids);
		const op: CommitOp = { action, path: `${collection}/${rkey}`, cid: newCid };
		if (prev !== undefined) op.prev = prev;
		this.onCommit?.({
			did: this.ctx.commit.did,
			rev: this.ctx.commit.rev,
			since,
			commitCid: this.ctx.rootCid,
			diffCar,
			ops: [op],
			prevData,
		});
		return {
			uri: this.toUri(collection, rkey),
			cid: newCid,
			commit: { cid: this.commitCid, rev: this.commitRev },
		};
	}

	async deleteRecord(
		collection: string,
		rkey: string,
	): Promise<{ commit: { cid: string; rev: string } }> {
		this.requireNsid(collection);
		this.requireRkey(rkey);
		const existing = await this.getRecord(collection, rkey);
		await removeRecord(collection, rkey);
		const since = this.commitRev;
		const prevData = this.ctx.commit.data.$link;
		const oldCids = await this.snapshotCids();
		await this.rebuild();
		const diffCar = await this.computeDiffCar(oldCids);
		const op: CommitOp = {
			action: "delete",
			path: `${collection}/${rkey}`,
			cid: null,
		};
		if (existing) op.prev = existing.cid;
		this.onCommit?.({
			did: this.ctx.commit.did,
			rev: this.ctx.commit.rev,
			since,
			commitCid: this.ctx.rootCid,
			diffCar,
			ops: [op],
			prevData,
		});
		return { commit: { cid: this.commitCid, rev: this.commitRev } };
	}

	async applyWrites(ops: WriteOp[]): Promise<ApplyWritesResult> {
		for (const op of ops) {
			this.requireNsid(op.collection);
			this.requireRkey(op.rkey);
		}
		const prevCids = new Map<string, string>();
		for (const op of ops) {
			if (op.action !== "create") {
				const existing = await this.getRecord(op.collection, op.rkey);
				if (existing) prevCids.set(`${op.collection}/${op.rkey}`, existing.cid);
			}
		}
		for (const op of ops) {
			if (op.action === "delete") {
				await removeRecord(op.collection, op.rkey);
			} else {
				const parsed = recordSchema.safeParse(op.value);
				if (!parsed.success) {
					throw new InternalServerError({
						message: "write value must be an object",
					});
				}
				await writeRecord(op.collection, op.rkey, parsed.data);
			}
		}
		const since = this.commitRev;
		const prevData = this.ctx.commit.data.$link;
		const oldCids = await this.snapshotCids();
		await this.rebuild();
		const walker = await NodeWalker.create(
			this.nodeStore(),
			this.ctx.commit.data.$link,
		);
		const items: ApplyWriteItem[] = await Promise.all(
			ops.map(async (op) => {
				if (op.action === "delete") return { type: "delete" as const };
				const cidLink = await walker.findRpath(`${op.collection}/${op.rkey}`);
				return {
					type: op.action,
					uri: this.toUri(op.collection, op.rkey),
					cid: this.requireCidLink(cidLink, `${op.collection}/${op.rkey}`)
						.$link,
				};
			}),
		);
		const diffCar = await this.computeDiffCar(oldCids);
		const commitOps: CommitOp[] = ops.map((op, i) => {
			const path = `${op.collection}/${op.rkey}`;
			const prev = prevCids.get(path);
			if (op.action === "delete") {
				return { action: "delete", path, cid: null, ...(prev ? { prev } : {}) };
			}
			const item = items[i];
			const newCid = item.type !== "delete" ? item.cid : null;
			return {
				action: op.action,
				path,
				cid: newCid,
				...(prev ? { prev } : {}),
			};
		});
		this.onCommit?.({
			did: this.ctx.commit.did,
			rev: this.ctx.commit.rev,
			since,
			commitCid: this.ctx.rootCid,
			diffCar,
			ops: commitOps,
			prevData,
		});
		return { commit: { cid: this.commitCid, rev: this.commitRev }, items };
	}

	async getRecord(
		collection: string,
		rkey: string,
	): Promise<{
		uri: string;
		cid: string;
		value: Record<string, unknown>;
	} | null> {
		const walker = await NodeWalker.create(
			this.nodeStore(),
			this.ctx.commit.data.$link,
		);
		const cidLink = await walker.findRpath(`${collection}/${rkey}`);
		if (!cidLink) return null;
		const bytes = await this.ctx.storage.get(cidLink.$link);
		if (!bytes) return null;
		const decoded = recordSchema.safeParse(decode(bytes));
		if (!decoded.success) return null;
		return {
			uri: this.toUri(collection, rkey),
			cid: cidLink.$link,
			value: decoded.data,
		};
	}

	async listRecords(collection: string, limit: number): Promise<RecordEntry[]> {
		const walker = await NodeWalker.create(
			this.nodeStore(),
			this.ctx.commit.data.$link,
		);
		const start = `${collection}/`;
		const end = `${collection}/\xff`;
		const records: RecordEntry[] = [];
		for await (const [rpath, cidLink] of walker.entriesInRange(start, end)) {
			if (records.length >= limit) break;
			const bytes = await this.ctx.storage.get(cidLink.$link);
			if (!bytes) continue;
			const decoded = recordSchema.safeParse(decode(bytes));
			if (!decoded.success) continue;
			const rkey = rpath.slice(start.length);
			records.push({
				uri: this.toUri(collection, rkey),
				cid: cidLink.$link,
				value: decoded.data,
			});
		}
		return records;
	}

	async getCollections(): Promise<string[]> {
		const walker = await NodeWalker.create(
			this.nodeStore(),
			this.ctx.commit.data.$link,
		);
		const set = new Set<string>();
		for await (const [rpath] of walker.entries()) {
			const collection = rpath.split("/")[0];
			set.add(collection);
		}
		return Array.from(set);
	}

	async putBlob(bytes: Uint8Array): Promise<{ ref: string; size: number }> {
		const cidStr = await putBlob(bytes);
		return { ref: cidStr, size: bytes.length };
	}

	getRepoCar(): Response {
		const storage = this.ctx.storage;
		const rootCid = this.ctx.rootCid;

		async function* blocks() {
			for await (const { cidStr, bytes } of storage.iterAllBlocks()) {
				yield { cid: CID.fromString(cidStr).bytes, data: bytes };
			}
		}

		return new Response(
			ReadableStream.from(writeCarStream([{ $link: rootCid }], blocks())),
			{ headers: { "content-type": "application/vnd.ipld.car" } },
		);
	}

	getBlocksCarBytes(cidStrs: string[]): Promise<Uint8Array> {
		const storage = this.ctx.storage;

		async function* blocks() {
			for (const cidStr of cidStrs) {
				if (!isCid(cidStr)) continue;
				const bytes = await storage.get(cidStr);
				if (bytes) yield { cid: CID.fromString(cidStr).bytes, data: bytes };
			}
		}

		return collectStream(writeCarStream([], blocks()));
	}

	async getRecordProofCar(
		collection: string,
		rkey: string,
	): Promise<Uint8Array | null> {
		const key = `${collection}/${rkey}`;
		const walker = await NodeWalker.create(
			this.nodeStore(),
			this.ctx.commit.data.$link,
		);
		const foundCidLink = await walker.findRpath(key);
		if (!foundCidLink) return null;
		const recordCidStr = foundCidLink.$link;

		const storage = this.ctx.storage;
		const rootCid = this.ctx.rootCid;
		const dataCid = this.ctx.commit.data.$link;

		async function* blocks() {
			const commitBytes = await storage.get(rootCid);
			if (commitBytes) {
				yield { cid: CID.fromString(rootCid).bytes, data: commitBytes };
			}

			const ns = new NodeStore(
				new OverlayBlockStore(new MemoryBlockStore(), storage),
			);
			const nodeWalker = await NodeWalker.create(ns, dataCid);
			for await (const nodeCidLink of nodeWalker.nodeCids()) {
				const bytes = await storage.get(nodeCidLink.$link);
				if (bytes) {
					yield { cid: CID.fromString(nodeCidLink.$link).bytes, data: bytes };
				}
			}

			const recordBytes = await storage.get(recordCidStr);
			if (recordBytes) {
				yield { cid: CID.fromString(recordCidStr).bytes, data: recordBytes };
			}
		}

		return collectStream(writeCarStream([{ $link: rootCid }], blocks()));
	}

	getBlobBytes(cidStr: string): Promise<Uint8Array | null> {
		if (!isCid(cidStr)) return Promise.resolve(null);
		return getBlob(cidStr);
	}

	async listBlobCids(
		limit: number,
		cursor?: string,
	): Promise<{ cids: string[]; cursor?: string }> {
		const all = await listBlobCids();
		const startIndex = cursor ? all.indexOf(cursor) + 1 : 0;
		const page = all.slice(startIndex, startIndex + limit);
		const nextCursor =
			page.length === limit ? page[page.length - 1] : undefined;
		return { cids: page, ...(nextCursor ? { cursor: nextCursor } : {}) };
	}
}

async function collectStream(
	stream: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
	return new Uint8Array(
		await new Response(ReadableStream.from(stream)).arrayBuffer(),
	);
}
