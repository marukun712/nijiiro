import { ComAtprotoSyncSubscribeRepos } from "@atcute/atproto";
import type { XRPCRouter } from "@atcute/xrpc-server";
import type { Firehose } from "./firehose.ts";

export function registerSyncHandlers(router: XRPCRouter, firehose: Firehose) {
	router.addSubscription(ComAtprotoSyncSubscribeRepos, {
		async *handler({ signal }) {
			const stream = firehose.subscribe();
			signal.addEventListener("abort", () => stream.cancel());

			for await (const message of stream) {
				yield message;
			}
		},
	});
}
