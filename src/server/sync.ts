import {
	ComAtprotoSyncGetRepo,
	ComAtprotoSyncListRepos,
	ComAtprotoSyncSubscribeRepos,
} from "@atcute/atproto";
import type { XRPCRouter } from "@atcute/xrpc-server";
import { writeCarStream } from "@atproto/repo";
import type { Firehose } from "./firehose.ts";
import type { RepoContext } from "./repo.ts";
import { withErrorLog } from "./util.ts";

export function registerSyncHandlers(
	router: XRPCRouter,
	firehose: Firehose,
	ctx: RepoContext,
) {
	router.addQuery(ComAtprotoSyncGetRepo, {
		handler: ({ params }) =>
			withErrorLog("getRepo", async () => {
				console.log("[handler] getRepo:", params.did);

				async function* allBlocks() {
					const commitBytes = await ctx.repo.storage.getBytes(ctx.repo.cid);
					if (commitBytes) yield { cid: ctx.repo.cid, bytes: commitBytes };
					yield* ctx.repo.data.carBlockStream();
				}

				const chunks: Uint8Array[] = [];
				for await (const chunk of writeCarStream(ctx.repo.cid, allBlocks())) {
					chunks.push(chunk);
				}

				const total = chunks.reduce((n, c) => n + c.length, 0);
				const car = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) {
					car.set(chunk, offset);
					offset += chunk.length;
				}

				return new Response(car, {
					headers: { "content-type": "application/vnd.ipld.car" },
				});
			}),
	});

	router.addQuery(ComAtprotoSyncListRepos, {
		handler: () =>
			withErrorLog("listRepos", () => {
				console.log("[handler] listRepos");
				return Promise.resolve(
					Response.json({
						repos: [
							{
								did: ctx.repo.did,
								head: ctx.repo.cid.toString(),
								rev: ctx.repo.commit.rev,
								active: true,
							},
						],
					}),
				);
			}),
	});

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
