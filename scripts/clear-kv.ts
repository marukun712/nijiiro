const kv = await Deno.openKv();

const iter = kv.list({ prefix: [] });
let count = 0;
for await (const entry of iter) {
	await kv.delete(entry.key);
	count++;
}

console.log(`deleted ${count} entries`);
kv.close();
