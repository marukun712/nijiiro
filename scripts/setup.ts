import { Secp256k1Keypair } from "@atproto/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";

const keypair = await Secp256k1Keypair.create({ exportable: true });
const signingKeyHex = bytesToHex(await keypair.export());

const jwtSecret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

const adminPasswordBytes = crypto.getRandomValues(new Uint8Array(16));
const adminPassword = btoa(String.fromCharCode(...adminPasswordBytes));

console.log(`REPO_SIGNING_KEY=${signingKeyHex}`);
console.log(`JWT_SECRET=${jwtSecret}`);
console.log(`ADMIN_PASSWORD=${adminPassword}`);
console.log(`REPO_SIGNING_KEY_DID=${keypair.did()}`);
