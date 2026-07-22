import {
	ComAtprotoRepoApplyWrites,
	ComAtprotoRepoCreateRecord,
	ComAtprotoRepoDeleteRecord,
	ComAtprotoRepoDescribeRepo,
	ComAtprotoRepoGetRecord,
	ComAtprotoRepoListRecords,
	ComAtprotoRepoPutRecord,
	ComAtprotoRepoUploadBlob,
} from "@atcute/atproto";
import { isResourceUri } from "@atcute/lexicons";
import { isDid, isHandle, isNsid } from "@atcute/lexicons/syntax";
import { now as tidNow } from "@atcute/tid";
import {
	InternalServerError,
	json,
	type XRPCRouter,
} from "@atcute/xrpc-server";
import type { AuthContext } from "../services/auth.ts";
import { verifyAccessToken } from "../services/auth.ts";
import type { RepoService, WriteOp } from "../services/repo.ts";
import { withErrorLog } from "../util.ts";

type WriteEntry =
	| ComAtprotoRepoApplyWrites.Create
	| ComAtprotoRepoApplyWrites.Update
	| ComAtprotoRepoApplyWrites.Delete;

function toWriteOp(w: WriteEntry): WriteOp {
	if (!("value" in w)) {
		return { action: "delete", collection: w.collection, rkey: w.rkey };
	}
	if (w.$type === "com.atproto.repo.applyWrites#update") {
		return {
			action: "update",
			collection: w.collection,
			rkey: w.rkey,
			value: w.value,
		};
	}
	return {
		action: "create",
		collection: w.collection,
		rkey: w.rkey ?? tidNow(),
		value: w.value,
	};
}

function toUri(uriStr: string) {
	if (!isResourceUri(uriStr)) {
		throw new InternalServerError({
			message: `constructed an invalid resource uri: ${uriStr}`,
		});
	}
	return uriStr;
}

export function registerRepoHandlers(
	router: XRPCRouter,
	service: RepoService,
	handle: string,
	auth: AuthContext,
) {
	router.addProcedure(ComAtprotoRepoApplyWrites, {
		handler: ({ input, request }) =>
			withErrorLog("applyWrites", async () => {
				console.log("[handler] applyWrites:", input.writes.length, "ops");
				await verifyAccessToken(request, auth);
				const ops = input.writes.map(toWriteOp);
				const { commit, items } = await service.applyWrites(ops);

				const results = items.map((item) => {
					if (item.type === "delete") {
						return {
							$type: "com.atproto.repo.applyWrites#deleteResult" as const,
						};
					}
					return {
						$type: `com.atproto.repo.applyWrites#${item.type}Result` as const,
						uri: toUri(item.uri),
						cid: item.cid,
					};
				});

				return json({ commit, results });
			}),
	});

	router.addProcedure(ComAtprotoRepoCreateRecord, {
		handler: ({ input, request }) =>
			withErrorLog("createRecord", async () => {
				console.log("[handler] createRecord:", input.collection);
				await verifyAccessToken(request, auth);
				const rkey = input.rkey ?? tidNow();
				const result = await service.createRecord(
					input.collection,
					rkey,
					input.record,
				);
				return json({ ...result, uri: toUri(result.uri) });
			}),
	});

	router.addProcedure(ComAtprotoRepoPutRecord, {
		handler: ({ input, request }) =>
			withErrorLog("putRecord", async () => {
				console.log(
					"[handler] putRecord:",
					`${input.collection}/${input.rkey}`,
				);
				await verifyAccessToken(request, auth);
				const result = await service.putRecord(
					input.collection,
					input.rkey,
					input.record,
				);
				return json({ ...result, uri: toUri(result.uri) });
			}),
	});

	router.addProcedure(ComAtprotoRepoDeleteRecord, {
		handler: ({ input, request }) =>
			withErrorLog("deleteRecord", async () => {
				console.log(
					"[handler] deleteRecord:",
					`${input.collection}/${input.rkey}`,
				);
				await verifyAccessToken(request, auth);
				const result = await service.deleteRecord(input.collection, input.rkey);
				return json(result);
			}),
	});

	router.addQuery(ComAtprotoRepoGetRecord, {
		handler: ({ params }) =>
			withErrorLog("getRecord", async () => {
				console.log(
					"[handler] getRecord:",
					`${params.collection}/${params.rkey}`,
				);
				const record = await service.getRecord(params.collection, params.rkey);
				if (!record) {
					return new Response(
						JSON.stringify({
							error: "RecordNotFound",
							message: "record not found",
						}),
						{ status: 400, headers: { "content-type": "application/json" } },
					);
				}
				return json({ ...record, uri: toUri(record.uri), value: record.value });
			}),
	});

	router.addQuery(ComAtprotoRepoListRecords, {
		handler: ({ params }) =>
			withErrorLog("listRecords", async () => {
				console.log(
					"[handler] listRecords:",
					params.collection,
					"limit:",
					params.limit ?? 50,
				);
				const records = await service.listRecords(
					params.collection,
					params.limit ?? 50,
				);
				return json({
					records: records.map((r) => ({ ...r, uri: toUri(r.uri) })),
				});
			}),
	});

	router.addQuery(ComAtprotoRepoDescribeRepo, {
		handler: () =>
			withErrorLog("describeRepo", async () => {
				if (!isHandle(handle)) {
					throw new InternalServerError({
						message: `configured handle is invalid: ${handle}`,
					});
				}
				if (!isDid(service.did)) {
					throw new InternalServerError({
						message: `repo did is invalid: ${service.did}`,
					});
				}

				const rawCollections = await service.getCollections();
				const collections = rawCollections.filter(isNsid);

				return json({
					handle,
					did: service.did,
					didDoc: {},
					collections,
					handleIsCorrect: true,
				});
			}),
	});

	router.addProcedure(ComAtprotoRepoUploadBlob, {
		handler: ({ request }) =>
			withErrorLog("uploadBlob", async () => {
				await verifyAccessToken(request, auth);
				const bytes = new Uint8Array(await request.arrayBuffer());
				const mimeType =
					request.headers.get("content-type") ?? "application/octet-stream";
				console.log(
					"[handler] uploadBlob:",
					mimeType,
					`(${bytes.length} bytes)`,
				);
				const { ref, size } = await service.putBlob(bytes);
				return json({
					blob: {
						$type: "blob",
						ref: { $link: ref },
						mimeType,
						size,
					},
				});
			}),
	});
}
