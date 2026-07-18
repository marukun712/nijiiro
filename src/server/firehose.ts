import type { ComAtprotoSyncSubscribeRepos } from "@atcute/atproto";
import { toBytes } from "@atcute/cbor";
import { isDid } from "@atcute/lexicons/syntax";
import { InternalServerError } from "@atcute/xrpc-server";
import type { Cid } from "@atproto/lex-data";
import type { CommitData, RecordWriteOp } from "@atproto/repo";
import { blocksToCarFile } from "@atproto/repo";

type FirehoseMessage = ComAtprotoSyncSubscribeRepos.$message;

class AsyncQueue<T> {
	private items: T[] = [];
	private waiting: ((result: IteratorResult<T>) => void)[] = [];
	private closed = false;

	push(item: T) {
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: item, done: false });
			return;
		}
		this.items.push(item);
	}

	close() {
		this.closed = true;
		for (const waiter of this.waiting) waiter({ value: undefined, done: true });
		this.waiting = [];
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: (): Promise<IteratorResult<T>> => {
				const item = this.items.shift();
				if (item !== undefined) {
					return Promise.resolve({ value: item, done: false });
				}
				if (this.closed) {
					return Promise.resolve({ value: undefined, done: true });
				}
				return new Promise((resolve) => this.waiting.push(resolve));
			},
		};
	}
}

export class Firehose {
	private seq = 0;
	private queues = new Set<AsyncQueue<FirehoseMessage>>();

	subscribe(): AsyncQueue<FirehoseMessage> {
		const queue = new AsyncQueue<FirehoseMessage>();
		this.queues.add(queue);
		return queue;
	}

	unsubscribe(queue: AsyncQueue<FirehoseMessage>) {
		queue.close();
		this.queues.delete(queue);
	}

	private broadcast(message: FirehoseMessage) {
		for (const queue of this.queues) queue.push(message);
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
