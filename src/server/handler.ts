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
import { isResourceUri, type ResourceUri } from "@atcute/lexicons";
import { isDid, isHandle, isNsid, type Nsid } from "@atcute/lexicons/syntax";
import { now as tidNow } from "@atcute/tid";
import {
	InternalServerError,
	json,
	type XRPCRouter,
} from "@atcute/xrpc-server";
import type { Cid } from "@atproto/lex-data";
import { isLexMap, type LexMap } from "@atproto/lex-data";
import type { CommitData, RecordWriteOp } from "@atproto/repo";
import { WriteOpAction } from "@atproto/repo";
import type { AuthContext } from "./auth.ts";
import { verifyAccessToken } from "./auth.ts";
import type { Firehose } from "./firehose.ts";
import type { RepoContext } from "./repo.ts";
import { withErrorLog } from "./util.ts";

type WriteEntry =
	| ComAtprotoRepoApplyWrites.Create
	| ComAtprotoRepoApplyWrites.Update
	| ComAtprotoRepoApplyWrites.Delete;

function toLexMap(value: unknown): LexMap {
	if (!isLexMap(value)) {
		throw new InternalServerError({
			message: "record value is not a valid lex object",
		});
	}
	return value;
}

function toWriteOp(w: WriteEntry): RecordWriteOp {
	if (!("value" in w)) {
		return {
			action: WriteOpAction.Delete,
			collection: w.collection,
			rkey: w.rkey,
		};
	}
	const record = toLexMap(w.value);
	if (w.$type === "com.atproto.repo.applyWrites#update") {
		return {
			action: WriteOpAction.Update,
			collection: w.collection,
			rkey: w.rkey,
			record,
		};
	}
	return {
		action: WriteOpAction.Create,
		collection: w.collection,
		rkey: w.rkey ?? tidNow(),
		record,
	};
}

function toUri(did: string, collection: string, rkey: string): ResourceUri {
	const uri = `at://${did}/${collection}/${rkey}`;
	if (!isResourceUri(uri)) {
		throw new InternalServerError({
			message: `constructed an invalid resource uri: ${uri}`,
		});
	}
	return uri;
}

function requireCid<T>(cid: T | null, key: string): T {
	if (cid === null) {
		throw new InternalServerError({ message: `missing block for key: ${key}` });
	}
	return cid;
}

async function commitWrites(
	ctx: RepoContext,
	firehose: Firehose,
	ops: RecordWriteOp[],
) {
	const prevData = ctx.repo.commit.data;
	const commitData: CommitData = await ctx.repo.formatCommit(ops, ctx.keypair);
	ctx.repo = await ctx.repo.applyCommit(commitData);

	const opCids: (Cid | null)[] = await Promise.all(
		ops.map((op) =>
			op.action === WriteOpAction.Delete
				? Promise.resolve(null)
				: ctx.repo.data.get(`${op.collection}/${op.rkey}`),
		),
	);

	await firehose.publishCommit(ctx.repo.did, ops, opCids, commitData, prevData);

	return { commitData, opCids };
}

export function registerRepoHandlers(
	router: XRPCRouter,
	ctx: RepoContext,
	firehose: Firehose,
	handle: string,
	auth: AuthContext,
) {
	router.addProcedure(ComAtprotoRepoApplyWrites, {
		handler: ({ input, request }) =>
			withErrorLog("applyWrites", async () => {
				console.log("[handler] applyWrites:", input.writes.length, "ops");
				await verifyAccessToken(request, auth);
				const ops = input.writes.map(toWriteOp);
				const { commitData, opCids } = await commitWrites(ctx, firehose, ops);

				const results = ops.map((op, i) => {
					if (op.action === WriteOpAction.Delete) {
						return {
							$type: "com.atproto.repo.applyWrites#deleteResult" as const,
						};
					}
					const cid = requireCid(opCids[i], `${op.collection}/${op.rkey}`);
					return {
						$type: `com.atproto.repo.applyWrites#${op.action}Result` as const,
						uri: toUri(ctx.repo.did, op.collection, op.rkey),
						cid: cid.toString(),
					};
				});

				return json({
					commit: { cid: commitData.cid.toString(), rev: commitData.rev },
					results,
				});
			}),
	});

	router.addProcedure(ComAtprotoRepoCreateRecord, {
		handler: ({ input, request }) =>
			withErrorLog("createRecord", async () => {
				console.log("[handler] createRecord:", input.collection);
				await verifyAccessToken(request, auth);
				const rkey = input.rkey ?? tidNow();
				const record = toLexMap(input.record);
				const op: RecordWriteOp = {
					action: WriteOpAction.Create,
					collection: input.collection,
					rkey,
					record,
				};
				const { commitData, opCids } = await commitWrites(ctx, firehose, [op]);
				const cid = requireCid(opCids[0], `${input.collection}/${rkey}`);
				return json({
					uri: toUri(ctx.repo.did, input.collection, rkey),
					cid: cid.toString(),
					commit: { cid: commitData.cid.toString(), rev: commitData.rev },
				});
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
				const record = toLexMap(input.record);
				const existing = await ctx.repo.getRecord(input.collection, input.rkey);
				const op: RecordWriteOp = {
					action: existing ? WriteOpAction.Update : WriteOpAction.Create,
					collection: input.collection,
					rkey: input.rkey,
					record,
				};
				const { commitData, opCids } = await commitWrites(ctx, firehose, [op]);
				const cid = requireCid(opCids[0], `${input.collection}/${input.rkey}`);
				return json({
					uri: toUri(ctx.repo.did, input.collection, input.rkey),
					cid: cid.toString(),
					commit: { cid: commitData.cid.toString(), rev: commitData.rev },
				});
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
				const op: RecordWriteOp = {
					action: WriteOpAction.Delete,
					collection: input.collection,
					rkey: input.rkey,
				};
				const { commitData } = await commitWrites(ctx, firehose, [op]);
				return json({
					commit: { cid: commitData.cid.toString(), rev: commitData.rev },
				});
			}),
	});

	router.addQuery(ComAtprotoRepoGetRecord, {
		handler: ({ params }) =>
			withErrorLog("getRecord", async () => {
				console.log(
					"[handler] getRecord:",
					`${params.collection}/${params.rkey}`,
				);
				const value = await ctx.repo.getRecord(params.collection, params.rkey);
				if (!value) {
					return new Response(
						JSON.stringify({
							error: "RecordNotFound",
							message: "record not found",
						}),
						{ status: 400, headers: { "content-type": "application/json" } },
					);
				}
				const cid = requireCid(
					await ctx.repo.data.get(`${params.collection}/${params.rkey}`),
					`${params.collection}/${params.rkey}`,
				);
				return json({
					uri: toUri(ctx.repo.did, params.collection, params.rkey),
					cid: cid.toString(),
					value: toLexMap(value),
				});
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
				const limit = params.limit ?? 50;
				const records: { uri: ResourceUri; cid: string; value: LexMap }[] = [];

				for await (const entry of ctx.repo.walkRecords(
					`${params.collection}/`,
				)) {
					if (entry.collection !== params.collection) break;
					if (records.length >= limit) break;
					records.push({
						uri: toUri(ctx.repo.did, entry.collection, entry.rkey),
						cid: entry.cid.toString(),
						value: toLexMap(entry.record),
					});
				}

				return json({ records });
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
				if (!isDid(ctx.repo.did)) {
					throw new InternalServerError({
						message: `repo did is invalid: ${ctx.repo.did}`,
					});
				}

				const collectionSet = new Set<string>();
				for await (const entry of ctx.repo.walkRecords()) {
					collectionSet.add(entry.collection);
				}

				const collections: Nsid[] = [];
				for (const c of collectionSet) {
					if (!isNsid(c)) {
						throw new InternalServerError({
							message: `collection is not a valid nsid: ${c}`,
						});
					}
					collections.push(c);
				}

				const didDoc: Record<string, unknown> = {};

				return json({
					handle,
					did: ctx.repo.did,
					didDoc,
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
				const cid = await ctx.storage.putBlob(bytes);
				return json({
					blob: {
						$type: "blob",
						ref: { $link: cid.toString() },
						mimeType,
						size: bytes.length,
					},
				});
			}),
	});
}
