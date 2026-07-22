import { decode } from "@atcute/cbor";
import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { isCommit } from "@atcute/repo";
import { XRPCRouter } from "@atcute/xrpc-server";
import { cors } from "@atcute/xrpc-server/middlewares/cors";
import { decodeHex } from "@std/encoding/hex";
import { LocalBlockStore } from "../blockstore/local.ts";
import { createJwtKey } from "./services/auth.ts";
import { FirehoseService } from "./services/firehose.ts";
import { createProxyMiddleware } from "./services/proxy.ts";
import { type RepoContext, RepoService } from "./services/repo.ts";
import { registerRepoHandlers } from "./xrpc/repo.ts";
import { registerServerHandlers } from "./xrpc/server.ts";
import { handleSubscribeRepos, registerSyncHandlers } from "./xrpc/sync.ts";

function getEnv(name: string, fallback?: string): string {
	const value = Deno.env.get(name) ?? fallback;
	if (value === undefined) throw new Error(`missing required env var: ${name}`);
	return value;
}

const REPO_DID = getEnv("REPO_DID");
const REPO_HANDLE = getEnv("REPO_HANDLE");
const REPO_SIGNING_KEY_HEX = getEnv("REPO_SIGNING_KEY");
const JWT_SECRET = getEnv("JWT_SECRET");
const ADMIN_PASSWORD = getEnv("ADMIN_PASSWORD");
const PORT = Number(getEnv("PORT", "8080"));

const keypair = await Secp256k1PrivateKeyExportable.importRaw(
	decodeHex(REPO_SIGNING_KEY_HEX),
);

console.log("[main] loading repo from ./repo");
const storage = new LocalBlockStore("./repo");
const rootCid = await storage.getRoot();
if (!rootCid) {
	throw new Error("./repo not found. run: deno task build");
}

const rootBytes = await storage.get(rootCid);
if (!rootBytes) {
	throw new Error("commit block missing in ./repo");
}

const decoded = decode(rootBytes);
if (!isCommit(decoded)) {
	throw new Error("invalid commit in ./repo");
}

console.log("[main] repo ready:", decoded.did);

const ctx: RepoContext = { storage, commit: decoded, rootCid };
const service = new RepoService(ctx);

const firehose = new FirehoseService();
service.onCommit = (data) => firehose.emit(data);

const auth = { jwtKey: createJwtKey(JWT_SECRET), serviceDid: REPO_DID };

const router = new XRPCRouter({ middlewares: [cors()] });
registerRepoHandlers(router, service, REPO_HANDLE, auth);
registerServerHandlers(router, auth, REPO_HANDLE, ADMIN_PASSWORD);
registerSyncHandlers(router, service);

const handler = createProxyMiddleware(
	router.fetch.bind(router),
	REPO_DID,
	keypair,
	auth,
);

console.log("[main] starting server on port:", PORT);
Deno.serve({ port: PORT }, (req) => {
	const url = new URL(req.url);
	if (
		url.pathname === "/xrpc/com.atproto.sync.subscribeRepos" &&
		req.headers.get("upgrade") === "websocket"
	) {
		return handleSubscribeRepos(req, firehose, service);
	}
	return handler(req);
});
