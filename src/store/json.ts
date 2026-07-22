import { exists } from "@std/fs";
import { z } from "zod";
import config from "../../config.ts";

const recordSchema = z.record(z.string(), z.unknown());

function collectionDir(collection: string): string {
	const override = config.collections[collection];
	if (override) return override;
	return `${config.defaultPath}/${collection}`;
}

function recordPath(collection: string, rkey: string): string {
	return `${collectionDir(collection)}/${rkey}.json`;
}

export async function readRecord(
	collection: string,
	rkey: string,
): Promise<Record<string, unknown> | null> {
	const path = recordPath(collection, rkey);
	const fileExists = await exists(path, { isFile: true });
	if (!fileExists) return null;
	const text = await Deno.readTextFile(path);
	const parsed = recordSchema.safeParse(JSON.parse(text));
	return parsed.success ? parsed.data : null;
}

export async function writeRecord(
	collection: string,
	rkey: string,
	record: Record<string, unknown>,
): Promise<void> {
	const dir = collectionDir(collection);
	await Deno.mkdir(dir, { recursive: true });
	await Deno.writeTextFile(
		recordPath(collection, rkey),
		JSON.stringify(record, null, 2),
	);
}

export async function removeRecord(
	collection: string,
	rkey: string,
): Promise<void> {
	const path = recordPath(collection, rkey);
	const fileExists = await exists(path, { isFile: true });
	if (!fileExists) return;
	await Deno.remove(path);
}

export async function readAllRecords(
	collection: string,
): Promise<{ rkey: string; record: Record<string, unknown> }[]> {
	const dir = collectionDir(collection);
	const dirExists = await exists(dir, { isDirectory: true });
	if (!dirExists) return [];
	const results: { rkey: string; record: Record<string, unknown> }[] = [];
	for await (const entry of Deno.readDir(dir)) {
		if (!entry.isFile || !entry.name.endsWith(".json")) continue;
		const rkey = entry.name.slice(0, -5);
		const text = await Deno.readTextFile(`${dir}/${entry.name}`);
		const parsed = recordSchema.safeParse(JSON.parse(text));
		if (!parsed.success) continue;
		results.push({ rkey, record: parsed.data });
	}
	return results;
}

export async function listAllCollections(): Promise<string[]> {
	const collections = new Set<string>();
	const overridden = new Set(Object.keys(config.collections));

	const defaultPathExists = await exists(config.defaultPath, {
		isDirectory: true,
	});
	if (defaultPathExists) {
		for await (const entry of Deno.readDir(config.defaultPath)) {
			if (entry.isDirectory && !overridden.has(entry.name)) {
				collections.add(entry.name);
			}
		}
	}

	for (const collection of Object.keys(config.collections)) {
		collections.add(collection);
	}

	return Array.from(collections);
}
