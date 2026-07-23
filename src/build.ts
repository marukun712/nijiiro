import { encode, toBytes } from "@atcute/cbor";
import * as CID from "@atcute/cid";
import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { isNsid } from "@atcute/lexicons/syntax";
import { MemoryBlockStore, NodeStore, NodeWrangler } from "@atcute/mst";
import { now as tidNow } from "@atcute/tid";
import { decodeHex } from "@std/encoding/hex";
import { exists } from "@std/fs";
import { listAllCollections, readAllRecords } from "./store/json.ts";

function getEnv(name: string): string {
	const value = Deno.env.get(name);
	if (!value) throw new Error(`missing required env var: ${name}`);
	return value;
}

export async function build(isStatic: boolean): Promise<void> {
	const REPO_DID = getEnv("REPO_DID");
	const REPO_SIGNING_KEY_HEX = getEnv("REPO_SIGNING_KEY");

	console.log("[build] loading keypair");
	const keyBytes = decodeHex(REPO_SIGNING_KEY_HEX);
	const keypair = await Secp256k1PrivateKeyExportable.importRaw(keyBytes);

	const memory = new MemoryBlockStore();
	const ns = new NodeStore(memory);
	const wrangler = new NodeWrangler(ns);

	console.log("[build] scanning collections");
	const collections = await listAllCollections();
	console.log("[build] found collections:", collections);

	let rootCid: string | null = null;

	for (const collection of collections) {
		if (!isNsid(collection)) {
			console.log(`[build] skipping invalid nsid: ${collection}`);
			continue;
		}
		const records = await readAllRecords(collection);
		console.log(`[build] ${collection}: ${records.length} records`);
		for (const { rkey, record } of records) {
			const recordBytes = encode(record);
			const recordCid = await CID.create(CID.CODEC_DCBOR, recordBytes);
			const recordCidStr = CID.toString(recordCid);
			await memory.put(recordCidStr, recordBytes);
			rootCid = await wrangler.putRecord(
				rootCid,
				`${collection}/${rkey}`,
				CID.toCidLink(recordCid),
			);
		}
	}

	const rev = tidNow();
	const commitWithoutSig = {
		version: 3,
		did: REPO_DID,
		data: { $link: rootCid ?? "" },
		rev,
		prev: null,
	};

	const sigInput = encode(commitWithoutSig);
	const sigBytes = await keypair.sign(sigInput);
	const commit = { ...commitWithoutSig, sig: toBytes(sigBytes) };

	const commitBytes = encode(commit);
	const commitCid = await CID.create(CID.CODEC_DCBOR, commitBytes);
	const commitCidStr = CID.toString(commitCid);
	await memory.put(commitCidStr, commitBytes);

	const prevRootExists = await exists("./repo/refs/root", { isFile: true });
	const prevRoot = prevRootExists
		? (await Deno.readTextFile("./repo/refs/root")).trim()
		: null;

	console.log("[build] cleaning ./repo (keeping blobs)");
	const repoDirExists = await exists("./repo", { isDirectory: true });
	if (repoDirExists) {
		for await (const entry of Deno.readDir("./repo")) {
			if (entry.name === "blobs") continue;
			await Deno.remove(`./repo/${entry.name}`, { recursive: true });
		}
	}
	await Deno.mkdir("./repo", { recursive: true });

	console.log("[build] writing blocks");
	for (const [cidStr, bytes] of memory.blocks) {
		await Deno.writeFile(`./repo/${cidStr}`, bytes);
	}

	console.log("[build] writing refs");
	await Deno.mkdir("./repo/refs", { recursive: true });
	await Deno.writeTextFile("./repo/refs/root", commitCidStr);

	if (isStatic && prevRoot !== commitCidStr) {
		await Deno.writeTextFile("./repo/refs/status", "1");
	}

	console.log("[build] done. root:", commitCidStr);
}
