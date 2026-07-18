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
import { isLexMap, type LexMap } from "@atproto/lex-data";
import type { RecordWriteOp } from "@atproto/repo";
import { WriteOpAction } from "@atproto/repo";
import type { RepoContext } from "./repo.ts";

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

export function registerRepoHandlers(
	router: XRPCRouter,
	ctx: RepoContext,
	handle: string,
) {
	router.addProcedure(ComAtprotoRepoApplyWrites, {
		async handler({ input }) {
			const ops = input.writes.map(toWriteOp);
			ctx.repo = await ctx.repo.applyWrites(ops, ctx.keypair);

			const results = await Promise.all(
				ops.map(async (op) => {
					if (op.action === WriteOpAction.Delete) {
						return {
							$type: "com.atproto.repo.applyWrites#deleteResult" as const,
						};
					}
					const cid = requireCid(
						await ctx.repo.data.get(`${op.collection}/${op.rkey}`),
						`${op.collection}/${op.rkey}`,
					);
					return {
						$type: `com.atproto.repo.applyWrites#${op.action}Result` as const,
						uri: toUri(ctx.repo.did, op.collection, op.rkey),
						cid: cid.toString(),
					};
				}),
			);

			return json({
				commit: { cid: ctx.repo.cid.toString(), rev: ctx.repo.commit.rev },
				results,
			});
		},
	});

	router.addProcedure(ComAtprotoRepoCreateRecord, {
		async handler({ input }) {
			const rkey = input.rkey ?? tidNow();
			const record = toLexMap(input.record);
			ctx.repo = await ctx.repo.applyWrites(
				[
					{
						action: WriteOpAction.Create,
						collection: input.collection,
						rkey,
						record,
					},
				],
				ctx.keypair,
			);
			const cid = requireCid(
				await ctx.repo.data.get(`${input.collection}/${rkey}`),
				`${input.collection}/${rkey}`,
			);
			return json({
				uri: toUri(ctx.repo.did, input.collection, rkey),
				cid: cid.toString(),
				commit: { cid: ctx.repo.cid.toString(), rev: ctx.repo.commit.rev },
			});
		},
	});

	router.addProcedure(ComAtprotoRepoPutRecord, {
		async handler({ input }) {
			const record = toLexMap(input.record);
			ctx.repo = await ctx.repo.applyWrites(
				[
					{
						action: WriteOpAction.Update,
						collection: input.collection,
						rkey: input.rkey,
						record,
					},
				],
				ctx.keypair,
			);
			const cid = requireCid(
				await ctx.repo.data.get(`${input.collection}/${input.rkey}`),
				`${input.collection}/${input.rkey}`,
			);
			return json({
				uri: toUri(ctx.repo.did, input.collection, input.rkey),
				cid: cid.toString(),
				commit: { cid: ctx.repo.cid.toString(), rev: ctx.repo.commit.rev },
			});
		},
	});

	router.addProcedure(ComAtprotoRepoDeleteRecord, {
		async handler({ input }) {
			ctx.repo = await ctx.repo.applyWrites(
				[
					{
						action: WriteOpAction.Delete,
						collection: input.collection,
						rkey: input.rkey,
					},
				],
				ctx.keypair,
			);
			return json({
				commit: { cid: ctx.repo.cid.toString(), rev: ctx.repo.commit.rev },
			});
		},
	});

	router.addQuery(ComAtprotoRepoGetRecord, {
		async handler({ params }) {
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
		},
	});

	router.addQuery(ComAtprotoRepoListRecords, {
		async handler({ params }) {
			const limit = params.limit ?? 50;
			const records: { uri: ResourceUri; cid: string; value: LexMap }[] = [];

			for await (const entry of ctx.repo.walkRecords(`${params.collection}/`)) {
				if (entry.collection !== params.collection) break;
				if (records.length >= limit) break;
				records.push({
					uri: toUri(ctx.repo.did, entry.collection, entry.rkey),
					cid: entry.cid.toString(),
					value: toLexMap(entry.record),
				});
			}

			return json({ records });
		},
	});

	router.addQuery(ComAtprotoRepoDescribeRepo, {
		async handler() {
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
		},
	});

	router.addProcedure(ComAtprotoRepoUploadBlob, {
		async handler({ request }) {
			const bytes = new Uint8Array(await request.arrayBuffer());
			const mimeType =
				request.headers.get("content-type") ?? "application/octet-stream";
			const cid = await ctx.storage.putBlob(bytes);
			return json({
				blob: {
					$type: "blob",
					ref: { $link: cid.toString() },
					mimeType,
					size: bytes.length,
				},
			});
		},
	});
}
