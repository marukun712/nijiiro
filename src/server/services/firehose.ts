import { encode } from "@atcute/cbor";

const BUFFER_SIZE = 100;

export type CommitOp = {
	action: "create" | "update" | "delete";
	path: string;
	cid: string | null;
	prev?: string;
};

export type CommitData = {
	did: string;
	rev: string;
	since: string | null;
	commitCid: string;
	diffCar: Uint8Array;
	ops: CommitOp[];
	prevData: string | null;
};

function encodeFrame(header: unknown, payload: unknown): Uint8Array {
	const headerBytes = encode(header);
	const payloadBytes = encode(payload);
	const frame = new Uint8Array(headerBytes.length + payloadBytes.length);
	frame.set(headerBytes, 0);
	frame.set(payloadBytes, headerBytes.length);
	return frame;
}

export function encodeErrorFrame(error: string, message?: string): Uint8Array {
	return encodeFrame({ op: -1 }, { error, ...(message ? { message } : {}) });
}

export function encodeSyncFrame(
	did: string,
	rev: string,
	seq: number,
	blocks: Uint8Array,
): Uint8Array {
	return encodeFrame(
		{ op: 1, t: "#sync" },
		{ seq, did, time: new Date().toISOString(), rev, blocks },
	);
}

export class FirehoseService {
	private subscribers = new Set<WebSocket>();
	private buffer: { seq: number; frame: Uint8Array }[] = [];
	lastSeq = 0;

	nextSeq(): number {
		const now = Date.now();
		this.lastSeq = Math.max(now, this.lastSeq + 1);
		return this.lastSeq;
	}

	emit(data: CommitData): void {
		const seq = this.nextSeq();
		const frame = encodeFrame(
			{ op: 1, t: "#commit" },
			{
				seq,
				did: data.did,
				time: new Date().toISOString(),
				repo: data.did,
				rev: data.rev,
				since: data.since,
				commit: { $link: data.commitCid },
				blocks: data.diffCar,
				ops: data.ops.map((op) => ({
					action: op.action,
					path: op.path,
					cid: op.cid !== null ? { $link: op.cid } : null,
					...(op.prev !== undefined ? { prev: { $link: op.prev } } : {}),
				})),
				prevData: data.prevData !== null ? { $link: data.prevData } : null,
			},
		);
		this.buffer.push({ seq, frame });
		if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
		for (const ws of this.subscribers) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(frame);
			}
		}
	}

	getBackfill(cursor: number): { frames: Uint8Array[]; expired: boolean } {
		if (cursor > this.lastSeq) {
			return { frames: [], expired: false };
		}
		if (this.buffer.length === 0 || cursor < this.buffer[0].seq) {
			return { frames: [], expired: true };
		}
		const idx = this.buffer.findIndex((e) => e.seq > cursor);
		if (idx === -1) return { frames: [], expired: false };
		return {
			frames: this.buffer.slice(idx).map((e) => e.frame),
			expired: false,
		};
	}

	addSubscriber(ws: WebSocket): void {
		this.subscribers.add(ws);
		ws.addEventListener("close", () => this.subscribers.delete(ws));
	}
}
