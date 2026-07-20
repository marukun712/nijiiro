import type { ComAtprotoSyncSubscribeRepos } from "@atcute/atproto";
import { toBytes } from "@atcute/cbor";
import { isDid } from "@atcute/lexicons/syntax";
import { InternalServerError } from "@atcute/xrpc-server";
import type { Cid } from "@atproto/lex-data";
import type { CommitData, RecordWriteOp } from "@atproto/repo";
import { blocksToCarFile } from "@atproto/repo";
import { z } from "zod";
import type { GitHubRepoStorage } from "../blockstore/github.ts";

type FirehoseMessage = ComAtprotoSyncSubscribeRepos.$message;

const PAGE_SIZE = 500;

export class Firehose {
	private seq: number;
	private storage: GitHubRepoStorage;
	private kv: Deno.Kv;
	private controllers = new Set<
		ReadableStreamDefaultController<FirehoseMessage>
	>();

	constructor(initialSeq: number, storage: GitHubRepoStorage, kv: Deno.Kv) {
		this.seq = initialSeq;
		this.storage = storage;
		this.kv = kv;
	}

	subscribe(cursor?: number): ReadableStream<FirehoseMessage> {
		let controller!: ReadableStreamDefaultController<FirehoseMessage>;
		return new ReadableStream<FirehoseMessage>({
			start: async (c) => {
				controller = c;

				if (cursor !== undefined) {
					let fromSeq = cursor + 1;
					while (true) {
						const iter = this.kv.list<FirehoseMessage>(
							{
								start: ["firehose", "event", fromSeq],
								end: ["firehose", "event", Number.MAX_SAFE_INTEGER],
							},
							{ limit: PAGE_SIZE },
						);
						let count = 0;
						for await (const entry of iter) {
							c.enqueue(entry.value);
							const seqResult = z.number().safeParse(entry.key[2]);
							if (!seqResult.success) break;
							fromSeq = seqResult.data + 1;
							count++;
						}
						if (count < PAGE_SIZE) break;
					}
				}

				this.controllers.add(c);
				console.log(
					"[firehose] subscriber connected (total:",
					this.controllers.size,
					")",
				);
			},
			cancel: () => {
				this.controllers.delete(controller);
				console.log(
					"[firehose] subscriber disconnected (total:",
					this.controllers.size,
					")",
				);
			},
		});
	}

	private broadcast(message: FirehoseMessage) {
		for (const controller of this.controllers) controller.enqueue(message);
	}

	async publishCommit(
		did: string,
		ops: RecordWriteOp[],
		opCids: (Cid | null)[],
		commitData: CommitData,
		prevData?: Cid,
	) {
		if (!isDid(did)) {
			throw new InternalServerError({ message: `repo did is invalid: ${did}` });
		}
		this.seq += 1;
		console.log(
			"[firehose] publishCommit seq:",
			this.seq,
			"ops:",
			ops.length,
			"subscribers:",
			this.controllers.size,
		);

		const carBytes = await blocksToCarFile(
			commitData.cid,
			commitData.newBlocks,
		);
		const { $bytes } = toBytes(carBytes);
		const repoOps = ops.map((op, i) => {
			const cid = opCids[i];
			return {
				action: op.action,
				path: `${op.collection}/${op.rkey}`,
				cid: cid ? { $link: cid.toString() } : null,
			};
		});

		const message: FirehoseMessage = {
			$type: "com.atproto.sync.subscribeRepos#commit",
			seq: this.seq,
			rebase: false,
			tooBig: false,
			repo: did,
			commit: { $link: commitData.cid.toString() },
			rev: commitData.rev,
			since: commitData.since,
			prevData: prevData ? { $link: prevData.toString() } : undefined,
			blocks: { $bytes },
			ops: repoOps,
			blobs: [],
			time: new Date().toISOString(),
		};

		await this.kv.set(["firehose", "event", this.seq], message);
		await this.storage.updateSeq(this.seq);

		this.broadcast(message);
	}
}
