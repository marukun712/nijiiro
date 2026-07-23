import * as CID from "@atcute/cid";
import { exists } from "@std/fs";
import config from "../../config.ts";

const blobDir = `${config.defaultPath}/blobs`;

export async function putBlob(bytes: Uint8Array): Promise<string> {
	const cid = await CID.create(CID.CODEC_RAW, bytes);
	const cidStr = CID.toString(cid);
	await Deno.mkdir(blobDir, { recursive: true });
	await Deno.writeFile(`${blobDir}/${cidStr}`, bytes);
	return cidStr;
}

export async function getBlob(cid: string): Promise<Uint8Array | null> {
	const path = `${blobDir}/${cid}`;
	const fileExists = await exists(path, { isFile: true });
	if (!fileExists) return null;
	return await Deno.readFile(path);
}

export async function listBlobCids(): Promise<string[]> {
	const dirExists = await exists(blobDir, { isDirectory: true });
	if (!dirExists) return [];
	const cids: string[] = [];
	for await (const entry of Deno.readDir(blobDir)) {
		if (entry.isFile) cids.push(entry.name);
	}
	return cids.sort();
}
