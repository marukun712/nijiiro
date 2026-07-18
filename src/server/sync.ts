import { ComAtprotoSyncSubscribeRepos } from "@atcute/atproto";
import type { XRPCRouter } from "@atcute/xrpc-server";
import type { Firehose } from "./firehose.ts";

export function registerSyncHandlers(router: XRPCRouter, firehose: Firehose) {
	router.addSubscription(ComAtprotoSyncSubscribeRepos, {
		async *handler({ signal }) {
			const queue = firehose.subscribe();
			signal.addEventListener("abort", () => firehose.unsubscribe(queue));

			for await (const message of queue) {
				if (signal.aborted) return;
				yield message;
			}
		},
	});
}
