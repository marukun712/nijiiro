import {
	ComAtprotoSyncGetBlob,
	ComAtprotoSyncGetBlocks,
	ComAtprotoSyncGetLatestCommit,
	ComAtprotoSyncGetRecord,
	ComAtprotoSyncGetRepo,
	ComAtprotoSyncGetRepoStatus,
	ComAtprotoSyncListBlobs,
	ComAtprotoSyncListRepos,
	ComAtprotoSyncSubscribeRepos,
} from "@atcute/atproto";
import type { XRPCRouter } from "@atcute/xrpc-server";
import { XRPCError } from "@atcute/xrpc-server";
import { enumBlobRefs, getBlobCidString, parseCid } from "@atproto/lex-data";
import { BlockMap, blocksToCarFile, writeCarStream } from "@atproto/repo";
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
			const reader = stream.getReader();
			signal.addEventListener("abort", () => reader.cancel());

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					yield value;
				}
			} finally {
				reader.releaseLock();
			}
		},
	});

	router.addQuery(ComAtprotoSyncGetLatestCommit, {
		handler: ({ params }) =>
			withErrorLog("getLatestCommit", () => {
				if (params.did !== ctx.repo.did) {
					throw new XRPCError({
						status: 404,
						error: "RepoNotFound",
						message: "repo not found",
					});
				}
				return Promise.resolve(
					Response.json({
						cid: ctx.repo.cid.toString(),
						rev: ctx.repo.commit.rev,
					}),
				);
			}),
	});

	router.addQuery(ComAtprotoSyncGetRepoStatus, {
		handler: ({ params }) =>
			withErrorLog("getRepoStatus", () => {
				if (params.did !== ctx.repo.did) {
					throw new XRPCError({
						status: 404,
						error: "RepoNotFound",
						message: "repo not found",
					});
				}
				return Promise.resolve(
					Response.json({
						did: ctx.repo.did,
						active: true,
						rev: ctx.repo.commit.rev,
					}),
				);
			}),
	});

	router.addQuery(ComAtprotoSyncGetBlob, {
		handler: ({ params }) =>
			withErrorLog("getBlob", async () => {
				if (params.did !== ctx.repo.did) {
					throw new XRPCError({
						status: 404,
						error: "RepoNotFound",
						message: "repo not found",
					});
				}
				const cid = parseCid(params.cid);
				const bytes = await ctx.storage.getBytes(cid);
				if (!bytes) {
					throw new XRPCError({
						status: 404,
						error: "BlobNotFound",
						message: "blob not found",
					});
				}
				return new Response(new Uint8Array(bytes), {
					headers: { "content-type": "application/octet-stream" },
				});
			}),
	});

	router.addQuery(ComAtprotoSyncGetBlocks, {
		handler: ({ params }) =>
			withErrorLog("getBlocks", async () => {
				if (params.did !== ctx.repo.did) {
					throw new XRPCError({
						status: 404,
						error: "RepoNotFound",
						message: "repo not found",
					});
				}
				const blocks = new BlockMap();
				for (const cidStr of params.cids) {
					const cid = parseCid(cidStr);
					const bytes = await ctx.storage.getBytes(cid);
					if (bytes) blocks.set(cid, bytes);
				}
				const car = await blocksToCarFile(null, blocks);
				return new Response(new Uint8Array(car), {
					headers: { "content-type": "application/vnd.ipld.car" },
				});
			}),
	});

	router.addQuery(ComAtprotoSyncGetRecord, {
		handler: ({ params }) =>
			withErrorLog("getRecord", async () => {
				if (params.did !== ctx.repo.did) {
					throw new XRPCError({
						status: 404,
						error: "RepoNotFound",
						message: "repo not found",
					});
				}
				const key = `${params.collection}/${params.rkey}`;
				const recordCid = await ctx.repo.data.get(key);
				if (!recordCid) {
					throw new XRPCError({
						status: 404,
						error: "RecordNotFound",
						message: "record not found",
					});
				}
				const proofBlocks = await ctx.repo.data.proofForKey(key);
				const recordBytes = await ctx.storage.getBytes(recordCid);
				if (recordBytes) proofBlocks.set(recordCid, recordBytes);
				const commitBytes = await ctx.storage.getBytes(ctx.repo.cid);
				if (commitBytes) proofBlocks.set(ctx.repo.cid, commitBytes);
				const car = await blocksToCarFile(ctx.repo.cid, proofBlocks);
				return new Response(new Uint8Array(car), {
					headers: { "content-type": "application/vnd.ipld.car" },
				});
			}),
	});

	router.addQuery(ComAtprotoSyncListBlobs, {
		handler: ({ params }) =>
			withErrorLog("listBlobs", async () => {
				if (params.did !== ctx.repo.did) {
					throw new XRPCError({
						status: 404,
						error: "RepoNotFound",
						message: "repo not found",
					});
				}
				const limit = params.limit ?? 500;
				const cursor = params.cursor;

				const blobCids = new Set<string>();
				for await (const entry of ctx.repo.walkRecords()) {
					for (const blobRef of enumBlobRefs(entry.record)) {
						const cidStr = getBlobCidString(blobRef);
						if (cidStr) blobCids.add(cidStr);
					}
				}

				const sorted = Array.from(blobCids).sort();
				const startIndex = cursor ? sorted.indexOf(cursor) + 1 : 0;
				const page = sorted.slice(startIndex, startIndex + limit);
				const nextCursor =
					page.length === limit ? page[page.length - 1] : undefined;

				return Response.json({
					cids: page,
					...(nextCursor ? { cursor: nextCursor } : {}),
				});
			}),
	});
}
