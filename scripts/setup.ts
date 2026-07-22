import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { encodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";

const keypair = await Secp256k1PrivateKeyExportable.createKeypair();
const signingKeyHex = await keypair.exportPrivateKey("rawHex");
const didKey = await keypair.exportPublicKey("did");

const jwtSecret = encodeHex(crypto.getRandomValues(new Uint8Array(32)));

const adminPasswordBytes = crypto.getRandomValues(new Uint8Array(16));
const adminPassword = encodeBase64(adminPasswordBytes);

console.log(`REPO_SIGNING_KEY=${signingKeyHex}`);
console.log(`JWT_SECRET=${jwtSecret}`);
console.log(`ADMIN_PASSWORD=${adminPassword}`);
console.log(`REPO_SIGNING_KEY_DID=${didKey}`);
