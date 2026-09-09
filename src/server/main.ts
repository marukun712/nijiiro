import { decode } from "@atcute/cbor";
import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import {
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
} from "@atcute/identity-resolver";
import { isCommit } from "@atcute/repo";
import { XRPCRouter } from "@atcute/xrpc-server";
import { cors } from "@atcute/xrpc-server/middlewares/cors";
import {
	ATProtoOAuthProvider,
	createAtcutePermissionSetResolver,
	InMemoryOAuthStorage,
} from "@getcirrus/oauth-provider";
import { decodeHex } from "@std/encoding/hex";
import { exists } from "@std/fs";
import config from "../../config.ts";
import { LocalBlockStore } from "../blockstore/local.ts";
import { createJwtKey, verifyAccessToken } from "./services/auth.ts";
import { FirehoseService } from "./services/firehose.ts";
import { createProxyMiddleware } from "./services/proxy.ts";
import { type RepoContext, RepoService } from "./services/repo.ts";
import { registerRepoHandlers } from "./xrpc/repo.ts";
import { registerServerHandlers } from "./xrpc/server.ts";
import { handleSubscribeRepos, registerSyncHandlers } from "./xrpc/sync.ts";

function withCors(res: Response): Response {
	const headers = new Headers(res.headers);
	headers.set("access-control-allow-origin", "*");
	return new Response(res.body, { status: res.status, headers });
}

function withExternalUrl(req: Request, pdsUrl: string): Request {
	const url = new URL(req.url);
	const externalUrl = new URL(url.pathname + url.search, pdsUrl);
	return new Request(externalUrl.href, req);
}

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
const PDS_URL = getEnv("PDS_URL", `http://localhost:8080`);
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

const didResolver = new CompositeDidDocumentResolver({
	methods: {
		plc: new PlcDidDocumentResolver(),
		web: new WebDidDocumentResolver(),
	},
});

const oauthStorage = new InMemoryOAuthStorage();
const oauthProvider = new ATProtoOAuthProvider({
	storage: oauthStorage,
	issuer: PDS_URL,
	verifyUser: (password: string) => {
		if (password !== ADMIN_PASSWORD) return Promise.resolve(null);
		return Promise.resolve({ sub: REPO_DID, handle: REPO_HANDLE });
	},
	permissionSetResolver: createAtcutePermissionSetResolver({
		dohUrl: "https://cloudflare-dns.com/dns-query",
		didDocumentResolver: didResolver,
	}),
});

const verifyToken = async (req: Request): Promise<void> => {
	const oauthData = await oauthProvider.verifyAccessToken(req);
	if (oauthData) return;
	await verifyAccessToken(req, auth);
};

const router = new XRPCRouter({ middlewares: [cors()] });
registerRepoHandlers(router, service, REPO_HANDLE, verifyToken);
registerServerHandlers(router, auth, REPO_HANDLE, ADMIN_PASSWORD, verifyToken);
registerSyncHandlers(router, service);

const handler = createProxyMiddleware(
	router.fetch.bind(router),
	REPO_DID,
	keypair,
	verifyToken,
);

async function requestCrawl(): Promise<void> {
	console.log("[main] requesting crawl from bsky.network");
	try {
		const res = await fetch(
			"https://bsky.network/xrpc/com.atproto.sync.requestCrawl",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ hostname: new URL(PDS_URL).hostname }),
			},
		);
		if (res.ok) {
			console.log("[main] requestCrawl succeeded");
		} else {
			console.error(
				"[main] requestCrawl failed:",
				res.status,
				await res.text(),
			);
		}
	} catch (err) {
		console.error("[main] requestCrawl error:", err);
	}
}

// 起動直後に1回、以後は15分おきにクロールリクエストをする
await requestCrawl();
setInterval(requestCrawl, 15 * 60 * 1000);

console.log("[main] starting server on port:", PORT);
Deno.serve(
	{
		port: PORT,
		onListen: async () => {
			const statusPath = "./repo/refs/status";
			const statusExists = await exists(statusPath, { isFile: true });
			if (statusExists) {
				const status = (await Deno.readTextFile(statusPath)).trim();
				if (status === "1") {
					console.log("[main] static build detected, emitting #sync");
					const syncCarBytes = await service.getSyncCarBytes();
					firehose.emitSync(service.did, service.commitRev, syncCarBytes);
					await Deno.remove(statusPath);
				}
			}
		},
	},
	async (req) => {
		const url = new URL(req.url);
		if (
			url.pathname === "/xrpc/com.atproto.sync.subscribeRepos" &&
			req.headers.get("upgrade") === "websocket"
		) {
			return handleSubscribeRepos(req, firehose, service);
		}
		if (req.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "GET, POST, OPTIONS",
					"access-control-allow-headers":
						"Content-Type, Authorization, DPoP, atproto-proxy, atproto-accept-labelers",
				},
			});
		}
		if (url.pathname === "/.well-known/did.json") {
			console.log("[main] serving did.json");
			return new Response(JSON.stringify(config.didDoc, null, 2), {
				headers: {
					"content-type": "application/json",
					"access-control-allow-origin": "*",
				},
			});
		}
		if (url.pathname === "/.well-known/atproto-did") {
			console.log("[main] serving atproto-did");
			return new Response(REPO_DID, {
				headers: {
					"content-type": "text/plain",
					"access-control-allow-origin": "*",
				},
			});
		}
		if (url.pathname === "/.well-known/oauth-protected-resource") {
			return new Response(
				JSON.stringify({
					resource: PDS_URL,
					authorization_servers: [PDS_URL],
					scopes_supported: [
						"atproto",
						"transition:generic",
						"transition:chat.bsky",
					],
					bearer_methods_supported: ["header"],
					resource_documentation: "https://atproto.com",
				}),
				{
					headers: {
						"content-type": "application/json",
						"access-control-allow-origin": "*",
					},
				},
			);
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			return withCors(oauthProvider.handleMetadata());
		}
		if (url.pathname === "/oauth/jwks") {
			return withCors(oauthProvider.handleJwks());
		}
		if (url.pathname === "/oauth/authorize") {
			console.log("[oauth] authorize", req.method, url.search);
			const res = withCors(await oauthProvider.handleAuthorize(req));
			console.log("[oauth] authorize response:", res.status);
			return res;
		}
		if (url.pathname === "/oauth/token") {
			console.log("[oauth] token", req.method);
			const res = withCors(
				await oauthProvider.handleToken(withExternalUrl(req, PDS_URL)),
			);
			console.log("[oauth] token response:", res.status);
			return res;
		}
		if (url.pathname === "/oauth/par") {
			console.log("[oauth] par", req.method);
			const res = withCors(
				await oauthProvider.handlePAR(withExternalUrl(req, PDS_URL)),
			);
			console.log("[oauth] par response:", res.status);
			return res;
		}
		return handler(withExternalUrl(req, PDS_URL));
	},
);
