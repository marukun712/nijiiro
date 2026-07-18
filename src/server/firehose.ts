import type { ComAtprotoSyncSubscribeRepos } from "@atcute/atproto";
import { toBytes } from "@atcute/cbor";
import { isDid } from "@atcute/lexicons/syntax";
import { InternalServerError } from "@atcute/xrpc-server";
import type { Cid } from "@atproto/lex-data";
import type { CommitData, RecordWriteOp } from "@atproto/repo";
import { blocksToCarFile } from "@atproto/repo";

type FirehoseMessage = ComAtprotoSyncSubscribeRepos.$message;

export class Firehose {
	private seq = 0;
	private controllers = new Set<
		ReadableStreamDefaultController<FirehoseMessage>
	>();

	subscribe(): ReadableStream<FirehoseMessage> {
		let controller!: ReadableStreamDefaultController<FirehoseMessage>;
		return new ReadableStream<FirehoseMessage>({
			start: (c) => {
				controller = c;
				this.controllers.add(c);
			},
			cancel: () => {
				this.controllers.delete(controller);
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
	) {
		if (!isDid(did)) {
			throw new InternalServerError({ message: `repo did is invalid: ${did}` });
		}
		this.seq += 1;

		const carBytes = await blocksToCarFile(
			commitData.cid,
			commitData.newBlocks,
		);
		const repoOps = ops.map((op, i) => {
			const cid = opCids[i];
			return {
				action: op.action,
				path: `${op.collection}/${op.rkey}`,
				cid: cid ? { $link: cid.toString() } : null,
			};
		});

		this.broadcast({
			$type: "com.atproto.sync.subscribeRepos#commit",
			seq: this.seq,
			rebase: false,
			tooBig: false,
			repo: did,
			commit: { $link: commitData.cid.toString() },
			rev: commitData.rev,
			since: commitData.since,
			blocks: toBytes(carBytes),
			ops: repoOps,
			blobs: [],
			time: new Date().toISOString(),
		});
	}
}
