import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { encodeBase64 } from "@std/encoding/base64";
import config from "../config.ts";

const keypair = await Secp256k1PrivateKeyExportable.createKeypair();
const signingKeyHex = await keypair.exportPrivateKey("rawHex");
const didKey = await keypair.exportPublicKey("did");

const adminPasswordBytes = crypto.getRandomValues(new Uint8Array(16));
const adminPassword = encodeBase64(adminPasswordBytes);

console.log(`REPO_SIGNING_KEY=${signingKeyHex}`);
console.log(`ADMIN_PASSWORD=${adminPassword}`);
console.log(`REPO_SIGNING_KEY_DID=${didKey}`);

const displayName = prompt("Display name:");
if (displayName) {
	const profileDir = `${config.defaultPath}/app.bsky.actor.profile`;
	await Deno.mkdir(profileDir, { recursive: true });
	await Deno.writeTextFile(
		`${profileDir}/self.json`,
		JSON.stringify({ $type: "app.bsky.actor.profile", displayName }, null, 2),
	);
	console.log(`Profile created: ${profileDir}/self.json`);
}
