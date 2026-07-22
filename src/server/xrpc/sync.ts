import {
	ComAtprotoSyncGetBlob,
	ComAtprotoSyncGetBlocks,
	ComAtprotoSyncGetLatestCommit,
	ComAtprotoSyncGetRecord,
	ComAtprotoSyncGetRepo,
	ComAtprotoSyncGetRepoStatus,
	ComAtprotoSyncListBlobs,
	ComAtprotoSyncListRepos,
} from "@atcute/atproto";
import type { XRPCRouter } from "@atcute/xrpc-server";
import { XRPCError } from "@atcute/xrpc-server";
import {
	encodeErrorFrame,
	encodeSyncFrame,
	type FirehoseService,
} from "../services/firehose.ts";
import type { RepoService } from "../services/repo.ts";
import { withErrorLog } from "../util.ts";

function requireSameDid(did: string, service: RepoService) {
	if (did !== service.did) {
		throw new XRPCError({
			status: 404,
			error: "RepoNotFound",
			message: "repo not found",
		});
	}
}

export async function handleSubscribeRepos(
	req: Request,
	firehose: FirehoseService,
	service: RepoService,
): Promise<Response> {
	const url = new URL(req.url);
	const cursorParam = url.searchParams.get("cursor");
	const cursor = cursorParam !== null ? Number(cursorParam) : undefined;

	const { socket, response } = Deno.upgradeWebSocket(req);

	socket.addEventListener("open", async () => {
		if (cursor !== undefined) {
			if (cursor > firehose.lastSeq) {
				socket.send(
					encodeErrorFrame("FutureCursor", "cursor is in the future"),
				);
				socket.close();
				return;
			}
			const { frames, expired } = firehose.getBackfill(cursor);
			if (expired) {
				const syncCarBytes = await service.getSyncCarBytes();
				socket.send(
					encodeSyncFrame(
						service.did,
						service.commitRev,
						firehose.nextSeq(),
						syncCarBytes,
					),
				);
			} else {
				for (const frame of frames) {
					socket.send(frame);
				}
			}
		}
		firehose.addSubscriber(socket);
	});

	return response;
}

export function registerSyncHandlers(router: XRPCRouter, service: RepoService) {
	router.addQuery(ComAtprotoSyncGetRepo, {
		handler: ({ params }) =>
			withErrorLog("getRepo", () => {
				console.log("[handler] getRepo:", params.did);
				requireSameDid(params.did, service);
				return Promise.resolve(service.getRepoCar());
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
								did: service.did,
								head: service.commitCid,
								rev: service.commitRev,
								active: true,
							},
						],
					}),
				);
			}),
	});

	router.addQuery(ComAtprotoSyncGetLatestCommit, {
		handler: ({ params }) =>
			withErrorLog("getLatestCommit", () => {
				requireSameDid(params.did, service);
				return Promise.resolve(
					Response.json({ cid: service.commitCid, rev: service.commitRev }),
				);
			}),
	});

	router.addQuery(ComAtprotoSyncGetRepoStatus, {
		handler: ({ params }) =>
			withErrorLog("getRepoStatus", () => {
				requireSameDid(params.did, service);
				return Promise.resolve(
					Response.json({
						did: service.did,
						active: true,
						rev: service.commitRev,
					}),
				);
			}),
	});

	router.addQuery(ComAtprotoSyncGetBlob, {
		handler: ({ params }) =>
			withErrorLog("getBlob", async () => {
				requireSameDid(params.did, service);
				const bytes = await service.getBlobBytes(params.cid);
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
				requireSameDid(params.did, service);
				const car = await service.getBlocksCarBytes(params.cids);
				return new Response(new Uint8Array(car), {
					headers: { "content-type": "application/vnd.ipld.car" },
				});
			}),
	});

	router.addQuery(ComAtprotoSyncGetRecord, {
		handler: ({ params }) =>
			withErrorLog("getRecord", async () => {
				requireSameDid(params.did, service);
				const car = await service.getRecordProofCar(
					params.collection,
					params.rkey,
				);
				if (!car) {
					throw new XRPCError({
						status: 404,
						error: "RecordNotFound",
						message: "record not found",
					});
				}
				return new Response(new Uint8Array(car), {
					headers: { "content-type": "application/vnd.ipld.car" },
				});
			}),
	});

	router.addQuery(ComAtprotoSyncListBlobs, {
		handler: ({ params }) =>
			withErrorLog("listBlobs", async () => {
				requireSameDid(params.did, service);
				const result = await service.listBlobCids(
					params.limit ?? 500,
					params.cursor,
				);
				return Response.json(result);
			}),
	});
}
